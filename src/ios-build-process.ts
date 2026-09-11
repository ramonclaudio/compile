import { addAbortListener } from "node:events";
import { open } from "node:fs/promises";
import timers from "node:timers/promises";

import { runCheckedProcess } from "./process.ts";
import type { NativeBuildOptions } from "./process.ts";
import { CompileError } from "./types.ts";

const databaseLocked = "database is locked";
const concurrentBuilds = "there are two concurrent builds running";
const retryDelays = [1_000, 2_000, 4_000] as const;

export async function runXcodeBuild(
  args: readonly string[],
  cwd: string,
  options: NativeBuildOptions,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    assertNotCancelled(options.signal);
    try {
      return await runCheckedProcess(
        "/usr/bin/xcrun",
        ["xcodebuild", ...args],
        {
          cwd,
          env: options.env,
          outputMode: options.outputMode ?? "stderr",
          signal: options.signal,
        },
        "xcodebuild",
        options.runProcess,
      );
    } catch (error) {
      const delay = retryDelays[attempt];
      if (
        delay === undefined ||
        !(error instanceof CompileError) ||
        error.signal !== undefined ||
        error.exitCode !== 65 ||
        !(await isConcurrentBuildError(error, options.signal))
      ) {
        throw error;
      }
      await waitToRetry(delay, options.signal);
    }
  }
}

async function isConcurrentBuildError(
  error: CompileError,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (error.message.includes(databaseLocked) && error.message.includes(concurrentBuilds))
    return true;
  if (error.logFilePath === undefined) return false;
  return fileHasConcurrentBuildError(error.logFilePath, signal);
}

async function fileHasConcurrentBuildError(
  logFilePath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const file = await open(logFilePath, "r");
    try {
      const buffer = Buffer.alloc(64 * 1_024);
      let previous = "";
      let hasDatabaseLock = false;
      let hasConcurrentBuilds = false;
      for (;;) {
        assertNotCancelled(signal);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return false;
        const output = previous + buffer.toString("utf8", 0, bytesRead);
        hasDatabaseLock ||= output.includes(databaseLocked);
        hasConcurrentBuilds ||= output.includes(concurrentBuilds);
        if (hasDatabaseLock && hasConcurrentBuilds) return true;
        previous = output.slice(-(concurrentBuilds.length - 1));
      }
    } finally {
      await file.close();
    }
  } catch {
    assertNotCancelled(signal);
    return false;
  }
}

async function waitToRetry(delay: number, signal: AbortSignal | undefined): Promise<void> {
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const cancel = (nativeSignal: NodeJS.Signals): void => {
    receivedSignal = nativeSignal;
    controller.abort();
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((nativeSignal) => {
    const listener = (): void => cancel(nativeSignal);
    process.on(nativeSignal, listener);
    return { nativeSignal, listener };
  });
  const abortSubscription =
    signal === undefined ? undefined : addAbortListener(signal, () => cancel("SIGTERM"));
  try {
    await timers.setTimeout(delay, undefined, { signal: controller.signal });
  } catch (error) {
    if (receivedSignal !== undefined) {
      throw new CompileError("Xcode build retry was cancelled.", { signal: receivedSignal });
    }
    throw error;
  } finally {
    for (const { nativeSignal, listener } of handlers) process.off(nativeSignal, listener);
    abortSubscription?.[Symbol.dispose]();
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CompileError("Xcode build was cancelled before starting.", { signal: "SIGTERM" });
  }
}
