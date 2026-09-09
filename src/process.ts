import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { addAbortListener } from "node:events";
import type { Readable } from "node:stream";

import { CompileError } from "./types.ts";
import type { BuildMode } from "./types.ts";

export type ProcessResult =
  | {
      readonly status: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: "signaled";
      readonly signal: NodeJS.Signals;
      readonly stdout: string;
      readonly stderr: string;
    };

export type BuildOutputMode = "stderr" | "quiet";

export interface RunProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly outputMode: "capture" | BuildOutputMode;
  readonly signal: AbortSignal | undefined;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export interface NativeBuildOptions {
  readonly outputMode?: BuildOutputMode | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly runProcess?: ProcessRunner | undefined;
}

type PipedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const outputTailBytes = 16 * 1_024;
const outputTailLines = 30;

interface ProcessCancellation {
  readonly signal: NodeJS.Signals | undefined;
  readonly dispose: () => void;
}

interface StreamedOutput {
  lastByte: number | undefined;
}

export function createBuildEnvironment(
  mode: BuildMode,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, NODE_ENV: mode };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    throw new CompileError("Process was cancelled before starting.", { signal: "SIGTERM" });
  }
  const childProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const streamedOutput: StreamedOutput | undefined =
    options.outputMode === "stderr" ? { lastByte: undefined } : undefined;
  readOutput(childProcess.stdout, stdoutChunks, options.outputMode, streamedOutput);
  readOutput(childProcess.stderr, stderrChunks, options.outputMode, streamedOutput);
  try {
    return await waitForClose(childProcess, command, stdoutChunks, stderrChunks, options.signal);
  } finally {
    if (streamedOutput?.lastByte !== undefined && streamedOutput.lastByte !== 10) {
      process.stderr.write("\n");
    }
  }
}

export async function runCheckedProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
  operation: string,
  runner: ProcessRunner = runProcess,
): Promise<string> {
  const processResult = await runner(command, args, options);
  if (processResult.status === "exited" && processResult.exitCode === 0) {
    return processResult.stdout;
  }
  const failure =
    processResult.status === "signaled"
      ? `${operation} stopped after receiving ${processResult.signal}`
      : `${operation} failed with exit code ${processResult.exitCode}`;
  let errorOutput = "";
  if (options.outputMode === "quiet") {
    errorOutput = [processResult.stdout.trim(), processResult.stderr.trim()]
      .filter(Boolean)
      .join("\n");
  } else if (processResult.status === "exited") {
    errorOutput = processResult.stderr.trim() || processResult.stdout.trim();
  }
  const errorMessage = errorOutput.length > 0 ? `${failure}:\n${errorOutput}` : `${failure}.`;
  throw new CompileError(
    errorMessage,
    processResult.status === "signaled"
      ? { signal: processResult.signal }
      : { exitCode: processResult.exitCode },
  );
}

function readOutput(
  stream: Readable,
  outputChunks: Buffer[],
  outputMode: RunProcessOptions["outputMode"],
  streamedOutput: StreamedOutput | undefined,
): void {
  if (outputMode === "capture") {
    stream.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    return;
  }
  if (streamedOutput !== undefined) stream.pipe(process.stderr, { end: false });
  stream.on("data", (chunk: Buffer) => {
    if (streamedOutput !== undefined && chunk.length > 0) {
      streamedOutput.lastByte = chunk[chunk.length - 1];
    }
    appendOutputTail(outputChunks, chunk);
  });
}

function appendOutputTail(outputChunks: Buffer[], chunk: Buffer): void {
  const output = Buffer.concat([...outputChunks, chunk]);
  let start = Math.max(0, output.length - outputTailBytes);
  let lines = 0;
  for (let index = output.length - 1; index >= start; index--) {
    if (output[index] === 10 && index !== output.length - 1 && ++lines === outputTailLines) {
      start = index + 1;
      break;
    }
  }
  while (start < output.length && (output.readUInt8(start) & 0xc0) === 0x80) start++;
  outputChunks.splice(0, outputChunks.length, Buffer.from(output.subarray(start)));
}

async function waitForClose(
  childProcess: PipedChildProcess,
  command: string,
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[],
  abortSignal: AbortSignal | undefined,
): Promise<ProcessResult> {
  const cancellation = forwardSignals(childProcess, abortSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      childProcess.once("error", (error) => {
        reject(new CompileError(`Could not start ${command}: ${error.message}`, { cause: error }));
      });
      childProcess.once("close", () => resolve());
    });
    return createProcessResult(
      childProcess.exitCode,
      cancellation.signal ?? childProcess.signalCode,
      stdoutChunks,
      stderrChunks,
    );
  } finally {
    cancellation.dispose();
  }
}

function createProcessResult(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[],
): ProcessResult {
  const capturedOutput = {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
  if (signal !== null) {
    return { status: "signaled", signal, ...capturedOutput };
  }
  if (exitCode !== null) {
    return { status: "exited", exitCode, ...capturedOutput };
  }
  throw new CompileError("Process closed without an exit code or signal.");
}

function forwardSignals(
  childProcess: PipedChildProcess,
  abortSignal: AbortSignal | undefined,
): ProcessCancellation {
  let forwardedSignal: NodeJS.Signals | undefined;
  const forwardSigint = (): void => {
    forwardedSignal = "SIGINT";
    signalProcess(childProcess, forwardedSignal);
  };
  const forwardSigterm = (): void => {
    forwardedSignal = "SIGTERM";
    signalProcess(childProcess, forwardedSignal);
  };
  const forwardSighup = (): void => {
    forwardedSignal = "SIGHUP";
    signalProcess(childProcess, forwardedSignal);
  };

  process.on("SIGINT", forwardSigint);
  process.on("SIGTERM", forwardSigterm);
  process.on("SIGHUP", forwardSighup);
  const abortSubscription =
    abortSignal === undefined ? undefined : addAbortListener(abortSignal, forwardSigterm);

  return {
    get signal() {
      return forwardedSignal;
    },
    dispose() {
      process.off("SIGINT", forwardSigint);
      process.off("SIGTERM", forwardSigterm);
      process.off("SIGHUP", forwardSighup);
      abortSubscription?.[Symbol.dispose]();
    },
  };
}

function signalProcess(childProcess: PipedChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    childProcess.kill(signal);
    return;
  }
  if (childProcess.pid === undefined) return;
  try {
    process.kill(-childProcess.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
