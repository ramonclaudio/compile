import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createBuildEnvironment, runCheckedProcess, runProcess } from "../src/process.ts";
import type { RunProcessOptions } from "../src/process.ts";
import { CompileError } from "../src/types.ts";
import { isRecord } from "../src/validation.ts";

const isWindows = process.platform === "win32";

const captureOptions: RunProcessOptions = {
  cwd: process.cwd(),
  env: undefined,
  outputMode: "capture",
  signal: undefined,
};

void test("sets the selected mode for native child processes", () => {
  assert.equal(createBuildEnvironment("development").NODE_ENV, "development");
  assert.equal(createBuildEnvironment("production").NODE_ENV, "production");
});

void test("copies the caller's environment and overrides only the native mode", () => {
  const env = Object.freeze({ COMPILE_TEST_VALUE: "caller", NODE_ENV: "test" });
  const originalMode = process.env.NODE_ENV;
  assert.deepEqual(createBuildEnvironment("production", env), {
    COMPILE_TEST_VALUE: "caller",
    NODE_ENV: "production",
  });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(process.env.NODE_ENV, originalMode);
});

void test("includes the native exit code and captured diagnostic in an error", async () => {
  await assert.rejects(
    runCheckedProcess(
      process.execPath,
      ["-e", 'process.stderr.write("native diagnostic"); process.exitCode = 65'],
      captureOptions,
      "Native build",
    ),
    { exitCode: 65, message: "Native build failed with exit code 65:\nnative diagnostic" },
  );
  await assert.rejects(
    runCheckedProcess(
      process.execPath,
      ["-e", "process.exitCode = 23"],
      captureOptions,
      "Native build",
    ),
    { exitCode: 23, message: "Native build failed with exit code 23." },
  );
});

void test("reports a process spawn failure", async () => {
  await assert.rejects(runProcess("/compile-test/missing-command", [], captureOptions), (error) => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, /Could not start \/compile-test\/missing-command/);
    assert.equal(error.exitCode, 1);
    assert.ok(error.cause instanceof Error && "code" in error.cause);
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
});

void test("preserves a native signal in a checked process error", async () => {
  await assert.rejects(
    runCheckedProcess("gradlew", [], captureOptions, "Gradle", async () => ({
      status: "signaled",
      signal: "SIGINT",
      stdout: "",
      stderr: "",
    })),
    {
      name: "CompileError",
      exitCode: 1,
      signal: "SIGINT",
      message: "Gradle stopped after receiving SIGINT.",
    },
  );
});

void test("returns rejected promises for invalid spawn arguments", async () => {
  await assert.rejects(runProcess("", [], captureOptions), {
    code: "ERR_INVALID_ARG_VALUE",
  });
  await assert.rejects(runProcess(process.execPath, ["\0"], captureOptions), {
    code: "ERR_INVALID_ARG_VALUE",
  });
});

void test("does not start a process when cancellation was already requested", async () => {
  await assert.rejects(
    runProcess("/compile-test/missing-command", [], {
      ...captureOptions,
      signal: AbortSignal.abort(),
    }),
    (error) =>
      error instanceof CompileError &&
      error.signal === "SIGTERM" &&
      /cancelled before starting/.test(error.message),
  );
});

void test("keeps stdout and stderr separate and preserves the exit code", async () => {
  const processResult = await runProcess(
    process.execPath,
    ["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exit(23)'],
    captureOptions,
  );

  assert.deepEqual(processResult, {
    status: "exited",
    exitCode: 23,
    stdout: "out",
    stderr: "err",
  });
});

void test("preserves a process signal", { skip: process.platform === "win32" }, async () => {
  const processResult = await runProcess(
    process.execPath,
    ["-e", 'process.kill(process.pid, "SIGTERM")'],
    captureOptions,
  );

  assert.equal(processResult.status, "signaled");
  assert.equal(processResult.signal, "SIGTERM");
});

void test("cancels a process with SIGTERM", async () => {
  const abortController = new AbortController();
  const processResultPromise = runProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { ...captureOptions, signal: abortController.signal },
  );
  abortController.abort();

  const processResult = await processResultPromise;
  assert.equal(processResult.status, "signaled");
  assert.equal(processResult.signal, "SIGTERM");
});

void test("cancels when another abort listener stops event propagation", async () => {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const pending = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 100)"], {
    ...captureOptions,
    signal: controller.signal,
  });
  controller.abort();

  const result = await pending;
  assert.equal(result.status, "signaled");
  assert.equal(result.signal, "SIGTERM");
});

for (const outcome of ["exited", "spawn-error", "cancelled"] as const) {
  void test(`removes process and abort listeners after ${outcome}`, async () => {
    const sigintListeners = process.listeners("SIGINT");
    const sigtermListeners = process.listeners("SIGTERM");
    const sighupListeners = process.listeners("SIGHUP");
    const controller = new AbortController();
    const pending = runProcess(
      outcome === "spawn-error" ? "/compile-test/missing-command" : process.execPath,
      ["-e", "setTimeout(() => {}, 100)"],
      { ...captureOptions, signal: controller.signal },
    );
    if (outcome === "cancelled") controller.abort();

    if (outcome === "spawn-error") {
      await assert.rejects(pending, /Could not start/);
    } else {
      const result = await pending;
      assert.equal(result.status, outcome === "cancelled" ? "signaled" : "exited");
    }
    assert.deepEqual(process.listeners("SIGINT"), sigintListeners);
    assert.deepEqual(process.listeners("SIGTERM"), sigtermListeners);
    assert.deepEqual(process.listeners("SIGHUP"), sighupListeners);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  });
}

void test("captures output from a descendant after the process leader exits", async () => {
  const descendant = 'setTimeout(() => process.stdout.write("tail"), 100)';
  const script = [
    'const { spawn } = require("node:child_process");',
    'process.stdout.write("head");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" }).unref();`,
  ].join("\n");
  const result = await runProcess(process.execPath, ["-e", script], captureOptions);

  assert.deepEqual(result, { status: "exited", exitCode: 0, stdout: "headtail", stderr: "" });
});

void test("forwards large native output without using stdout", async () => {
  const outputSize = 256 * 1_024;
  const childScript = `process.stdout.write("o".repeat(${outputSize})); process.stderr.write("e".repeat(${outputSize}))`;
  const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
  const parentScript = [
    `import { runProcess } from ${JSON.stringify(processModuleUrl)};`,
    `const result = await runProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: "stderr", signal: undefined });`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("");
  const processResult = await runProcess(
    process.execPath,
    ["--input-type=module", "-e", parentScript],
    captureOptions,
  );

  assert.equal(processResult.status, "exited");
  assert.equal(processResult.exitCode, 0, processResult.stderr);
  assert.ok(processResult.stderr.endsWith("\n"));
  const forwarded = processResult.stderr.slice(0, -1);
  assert.equal(forwarded.length, outputSize * 2);
  assert.equal(forwarded.replaceAll("o", "").length, outputSize);
  assert.equal(forwarded.replaceAll("e", "").length, outputSize);
  assert.deepEqual(JSON.parse(processResult.stdout), {
    status: "exited",
    exitCode: 0,
    stdout: "o".repeat(16 * 1_024),
    stderr: "e".repeat(16 * 1_024),
  });
});

void test("keeps only the last thirty streamed lines in a failure diagnostic", async () => {
  const lines = Array.from({ length: 100 }, (_, index) => `native line ${index}`).join("\n") + "\n";
  const childScript = `process.stderr.write(${JSON.stringify(lines)}); process.exitCode = 65`;
  const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
  const script = [
    `import { runCheckedProcess } from ${JSON.stringify(processModuleUrl)};`,
    "try {",
    `await runCheckedProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: "stderr", signal: undefined }, "Native build");`,
    "} catch (error) { process.stdout.write(JSON.stringify({ message: error.message, exitCode: error.exitCode })); }",
  ].join("\n");
  const result = await runProcess(
    process.execPath,
    ["--input-type=module", "-e", script],
    captureOptions,
  );
  assert.equal(result.status, "exited");
  assert.equal(result.stderr, lines);
  assert.deepEqual(JSON.parse(result.stdout), {
    exitCode: 65,
    message: `Native build failed with exit code 65:\n${lines.trimEnd().split("\n").slice(-30).join("\n")}`,
  });
});

void test("bounds a streamed diagnostic with a long UTF-8 line and no final newline", async () => {
  const output = "😀".repeat(10_000) + "final native diagnostic";
  const childScript =
    'process.stdout.write("😀".repeat(10_000) + "final native diagnostic"); process.exitCode = 23';
  const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
  const script = [
    `import { runCheckedProcess } from ${JSON.stringify(processModuleUrl)};`,
    "try {",
    `await runCheckedProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: "stderr", signal: undefined }, "Native build");`,
    "} catch (error) { process.stdout.write(JSON.stringify({ message: error.message, exitCode: error.exitCode })); }",
  ].join("\n");
  const result = await runProcess(
    process.execPath,
    ["--input-type=module", "-e", script],
    captureOptions,
  );
  assert.equal(result.status, "exited");
  assert.equal(result.stderr, `${output}\n`);
  const failure: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(failure));
  assert.equal(failure.exitCode, 23);
  assert.ok(typeof failure.message === "string");
  const prefix = "Native build failed with exit code 23:\n";
  assert.ok(failure.message.startsWith(prefix));
  const tail = failure.message.slice(prefix.length);
  assert.ok(Buffer.byteLength(tail) <= 16 * 1_024);
  assert.ok(tail.endsWith("final native diagnostic"));
  assert.ok(!tail.includes("\uFFFD"));
  assert.ok(tail.startsWith("😀"));
});

void test("terminates only unfinished streamed output across both native pipes", async () => {
  for (const [stdout, stderr] of [
    ["", ""],
    ["stdout\n", "stderr\n"],
    ["stdout", "stderr\n"],
    ["stdout\n", "stderr"],
    ["stdout", "stderr"],
  ] as const) {
    const childScript = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`;
    const moduleUrl = new URL("../dist/process.js", import.meta.url).href;
    const parentScript = [
      `import { runProcess } from ${JSON.stringify(moduleUrl)};`,
      `const result = await runProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: "stderr", signal: undefined });`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("");
    const result = await runProcess(
      process.execPath,
      ["--input-type=module", "-e", parentScript],
      captureOptions,
    );
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0, result.stderr);
    const expected = [stdout + stderr, stderr + stdout].map((output) =>
      output === "" || output.endsWith("\n") ? output : `${output}\n`,
    );
    assert.ok(
      expected.includes(result.stderr),
      JSON.stringify({ stdout, stderr, forwarded: result.stderr }),
    );
    assert.deepEqual(JSON.parse(result.stdout), { status: "exited", exitCode: 0, stdout, stderr });
  }
});

void test(
  "keeps cancellation when the child handles SIGTERM and exits with code 0",
  { skip: isWindows },
  async (context) => {
    const root = await temporaryDirectory(context);
    const ready = path.join(root, "ready");
    const controller = new AbortController();
    context.after(() => controller.abort());
    const code = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => process.exit(0));',
      `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const pending = runCheckedProcess(
      process.execPath,
      ["-e", code],
      { cwd: root, env: undefined, outputMode: "capture", signal: controller.signal },
      "Cancellation test",
    );
    const childPid = await readReadyPid(ready);
    context.after(() => sendSignal(childPid, "SIGTERM"));
    controller.abort();

    await assert.rejects(
      withTimeout(pending, "cancelled child"),
      (error) => error instanceof CompileError && error.signal === "SIGTERM",
    );
  },
);

void test(
  "cancels child processes that have descendants holding output pipes open",
  { skip: isWindows },
  async (context) => {
    const root = await temporaryDirectory(context);
    const childReady = path.join(root, "child-ready");
    const descendantReady = path.join(root, "descendant-ready");
    const controller = new AbortController();
    context.after(() => controller.abort());
    const descendantCode = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const code = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `fs.writeFileSync(${JSON.stringify(childReady)}, String(process.pid));`,
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "inherit" });`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const pending = runProcess(process.execPath, ["-e", code], {
      cwd: root,
      env: undefined,
      outputMode: "capture",
      signal: controller.signal,
    });
    const childPid = await readReadyPid(childReady);
    context.after(() => sendSignal(childPid, "SIGTERM"));
    const descendantPid = await readReadyPid(descendantReady);
    context.after(async () => {
      sendSignal(descendantPid, "SIGTERM");
      await pending;
    });
    controller.abort();

    const result = await withTimeout(pending, "cancelled process tree");
    assert.deepEqual(result, { status: "signaled", signal: "SIGTERM", stdout: "", stderr: "" });
    await withTimeout(waitForProcessExit(descendantPid), "descendant exit");
  },
);

void test(
  "forwards a second terminal interrupt to a child that is still shutting down",
  { skip: isWindows },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-repeated-interrupt-"));
    const ready = path.join(root, "pid");
    const interrupts = path.join(root, "interrupts");
    const childCode = [
      'const fs = require("node:fs");',
      "let interrupts = 0;",
      'process.on("SIGINT", () => {',
      "interrupts++;",
      `fs.writeFileSync(${JSON.stringify(interrupts)}, String(interrupts));`,
      "if (interrupts === 2) process.exit(0);",
      "});",
      `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      "setInterval(() => {}, 100);",
    ].join("");
    const moduleUrl = new URL("../dist/process.js", import.meta.url).href;
    const parentCode = [
      `import { runProcess } from ${JSON.stringify(moduleUrl)};`,
      `const result = await runProcess(process.execPath, ["-e", ${JSON.stringify(childCode)}], { cwd: ${JSON.stringify(root)}, env: undefined, outputMode: "capture", signal: undefined });`,
      "console.log(JSON.stringify(result));",
    ].join("");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentCode], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parentPid = parent.pid;
    assert.ok(parentPid !== undefined);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    parent.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    parent.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        parent.once("error", reject);
        parent.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    let childPid: number | undefined;
    context.after(async () => {
      sendSignal(-parentPid, "SIGTERM");
      if (childPid !== undefined) sendSignal(childPid, "SIGKILL");
      try {
        await withTimeout(closed, "interrupt parent cleanup");
      } finally {
        sendSignal(-parentPid, "SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    });
    const readyChildPid = await readNumberAtLeast(ready, 2);
    childPid = readyChildPid;
    sendSignal(-parentPid, "SIGINT");
    await readNumberAtLeast(interrupts, 1);
    sendSignal(-parentPid, "SIGINT");

    assert.deepEqual(
      await withTimeout(closed, "second interrupt"),
      { code: 0, signal: null },
      Buffer.concat(stderr).toString("utf8"),
    );
    assert.equal(await readFile(interrupts, "utf8"), "2");
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString("utf8")), {
      status: "signaled",
      signal: "SIGINT",
      stdout: "",
      stderr: "",
    });
    assert.throws(
      () => process.kill(readyChildPid, 0),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH",
    );
  },
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  void test(
    `CLI forwards ${signal} to the native process tree and preserves the signal`,
    { skip: isWindows },
    async (context) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "compile-cli-forward-signal-"));
      const childReady = path.join(root, "child-ready");
      const descendantReady = path.join(root, "descendant-ready");
      const descendantCode = [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const childCode = [
        'import { writeFileSync } from "node:fs";',
        'import { spawn } from "node:child_process";',
        `process.on(${JSON.stringify(signal)}, () => process.exit(0));`,
        `writeFileSync(${JSON.stringify(childReady)}, String(process.pid));`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "inherit" });`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      await writeFile(path.join(root, "gradle.mjs"), childCode);
      await writeFile(
        path.join(root, "gradlew"),
        '#!/bin/sh\nexec node "$(dirname "$0")/gradle.mjs"\n',
        {
          mode: 0o755,
        },
      );
      const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
      const parent = spawn(process.execPath, [cliPath, "android", "--dev"], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      parent.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      parent.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          parent.once("error", reject);
          parent.once("close", (code, closedSignal) => resolve({ code, signal: closedSignal }));
        },
      );
      let childPid: number | undefined;
      let descendantPid: number | undefined;
      context.after(async () => {
        if (parent.pid !== undefined) sendSignal(-parent.pid, "SIGKILL");
        if (childPid !== undefined) sendSignal(-childPid, "SIGKILL");
        if (descendantPid !== undefined) sendSignal(descendantPid, "SIGKILL");
        try {
          await withTimeout(closed, "CLI signal cleanup");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
      childPid = await readReadyPid(childReady);
      descendantPid = await readReadyPid(descendantReady);
      assert.ok(parent.pid !== undefined);
      sendSignal(parent.pid, signal);

      assert.deepEqual(await withTimeout(closed, "CLI signal forwarding"), { code: null, signal });
      assert.equal(Buffer.concat(stdout).toString("utf8"), "");
      assert.equal(
        Buffer.concat(stderr).toString("utf8"),
        `compile: Gradle stopped after receiving ${signal}.\n`,
      );
      await waitForProcessExit(childPid);
      await waitForProcessExit(descendantPid);
    },
  );
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-process-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readReadyPid(file: string): Promise<number> {
  const contents = await waitForFile(file);
  const pid = Number(contents);
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `Invalid process ID: ${contents}`);
  return pid;
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for process readiness at ${file}.`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Process ${pid} did not exit after cancellation.`);
}

async function withTimeout<T>(operation: Promise<T>, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function readNumberAtLeast(file: string, minimum: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(file, "utf8");
      const value = Number(contents);
      if (contents.trim() !== "" && Number.isSafeInteger(value) && value >= minimum) return value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out reading ${file}.`);
}
