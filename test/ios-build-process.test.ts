import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { runXcodeBuild } from "../src/ios-build-process.ts";
import type { ProcessResult, RunProcessOptions } from "../src/process.ts";
import { CompileError } from "../src/types.ts";

const lockMessage =
  "error: unable to attach DB: database is locked Possibly there are two concurrent builds running in the same filesystem location.";
const lockFailure: ProcessResult = {
  status: "exited",
  exitCode: 65,
  stdout: lockMessage,
  stderr: "** BUILD FAILED **",
};
const success: ProcessResult = { status: "exited", exitCode: 0, stdout: "built", stderr: "" };
const nativeSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

for (const outputMode of ["quiet", undefined] as const) {
  void test(`retries a transient Xcode lock with exact inputs (${outputMode ?? "default stderr"})`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const listeners = nativeListeners();
    const controller = new AbortController();
    const env = Object.freeze({ NODE_ENV: "custom-mode", RCT_NO_LAUNCH_PACKAGER: "1" });
    const args = Object.freeze(["-derivedDataPath", "clean", "clean", "build"]);
    const calls: { command: string; args: readonly string[]; options: RunProcessOptions }[] = [];
    const pending = runXcodeBuild(args, "/selected/project", {
      env,
      signal: controller.signal,
      outputMode,
      runProcess: async (command, actualArgs, options) => {
        calls.push({ command, args: actualArgs, options });
        return calls.length === 1 ? { ...lockFailure, stderr: "unrelated Xcode warning" } : success;
      },
    });
    await setImmediate();
    assert.equal(calls.length, 1);
    context.mock.timers.tick(999);
    await setImmediate();
    assert.equal(calls.length, 1);
    context.mock.timers.tick(1);
    assert.equal(await pending, "built");
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.command, "/usr/bin/xcrun");
      assert.deepEqual(call.args, ["xcodebuild", ...args]);
      assert.equal(call.options.cwd, "/selected/project");
      assert.equal(call.options.env, env);
      assert.equal(call.options.signal, controller.signal);
      assert.equal(call.options.outputMode, outputMode ?? "stderr");
    }
    assert.deepEqual(nativeListeners(), listeners);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

void test("stops after three retries with delays of one, two, and four seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = nativeListeners();
  let calls = 0;
  const pending = runXcodeBuild(["build"], "/selected/project", {
    outputMode: "quiet",
    runProcess: async () => {
      calls++;
      return { ...lockFailure, stderr: `attempt ${calls}` };
    },
  });
  const rejected = assert.rejects(
    pending,
    (error) =>
      error instanceof CompileError && error.exitCode === 65 && error.message.includes("attempt 4"),
  );
  for (const [index, delay] of [1_000, 2_000, 4_000].entries()) {
    await setImmediate();
    assert.equal(calls, index + 1);
    context.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(calls, index + 1);
    context.mock.timers.tick(1);
  }
  await rejected;
  assert.equal(calls, 4);
  assert.deepEqual(nativeListeners(), listeners);
});

void test("does not retry ordinary failures, partial lock messages, or cancellation", async () => {
  const listeners = nativeListeners();
  const failures: readonly ProcessResult[] = [
    { status: "exited", exitCode: 65, stdout: "error: compilation failed", stderr: "" },
    { status: "exited", exitCode: 65, stdout: "database is locked", stderr: "" },
    {
      status: "exited",
      exitCode: 65,
      stdout: "there are two concurrent builds running",
      stderr: "",
    },
    { ...lockFailure, exitCode: 1 },
    { ...lockFailure, exitCode: 75 },
    ...nativeSignals.map((signal): ProcessResult => ({
      status: "signaled",
      signal,
      stdout: lockMessage,
      stderr: "",
    })),
  ];
  for (const result of failures) {
    let calls = 0;
    await assert.rejects(
      runXcodeBuild(["build"], "/selected/project", {
        runProcess: async (_command, _args, options) => {
          calls++;
          assert.equal(options.outputMode, "stderr");
          return result;
        },
      }),
      (error) =>
        error instanceof CompileError &&
        (result.status === "signaled"
          ? error.signal === result.signal
          : error.exitCode === result.exitCode),
    );
    assert.equal(calls, 1);
  }
  const spawnError = new Error("spawn failed");
  await assert.rejects(
    runXcodeBuild(["build"], "/selected/project", {
      runProcess: async () => {
        throw spawnError;
      },
    }),
    (error) => error === spawnError,
  );
  assert.deepEqual(nativeListeners(), listeners);
});

void test("does not call an injected runner for an already cancelled build", async () => {
  let calls = 0;
  await assert.rejects(
    runXcodeBuild(["build"], "/selected/project", {
      signal: AbortSignal.abort(),
      runProcess: async () => {
        calls++;
        return success;
      },
    }),
    (error) => error instanceof CompileError && error.signal === "SIGTERM",
  );
  assert.equal(calls, 0);
});

void test("cancels backoff even when another listener stops abort propagation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = nativeListeners();
  const controller = new AbortController();
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const abortListeners = getEventListeners(controller.signal, "abort");
  let calls = 0;
  const pending = runXcodeBuild(["build"], "/selected/project", {
    outputMode: "quiet",
    signal: controller.signal,
    runProcess: async () => {
      calls++;
      return lockFailure;
    },
  });
  await setImmediate();
  assert.equal(process.listenerCount("SIGTERM"), listeners.SIGTERM.length + 1);
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof CompileError && error.signal === "SIGTERM",
  );
  controller.abort();
  await rejected;
  context.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  assert.deepEqual(nativeListeners(), listeners);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), abortListeners);
});

for (const signal of nativeSignals) {
  void test(`preserves ${signal} during backoff and removes its listeners`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const listeners = nativeListeners();
    let calls = 0;
    const pending = runXcodeBuild(["build"], "/selected/project", {
      outputMode: "quiet",
      runProcess: async () => {
        calls++;
        return lockFailure;
      },
    });
    await setImmediate();
    const rejected = assert.rejects(
      pending,
      (error) => error instanceof CompileError && error.signal === signal,
    );
    assert.equal(process.emit(signal), true);
    await rejected;
    context.mock.timers.tick(10_000);
    assert.equal(calls, 1);
    assert.deepEqual(nativeListeners(), listeners);
  });
}

for (const outputMode of ["quiet", "stderr"] as const) {
  void test(`finds lock messages outside the tail and across log chunks (${outputMode})`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-xcode-lock-log-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const logFilePath = path.join(root, "caller-owned.log");
    const output =
      "x".repeat(64 * 1_024 - 8) +
      "database is locked\n" +
      "x".repeat(64 * 1_024 - 20) +
      "there are two concurrent builds running\n" +
      "later output\n".repeat(100);
    await writeFile(logFilePath, output);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const listeners = nativeListeners();
    let calls = 0;
    const pending = runXcodeBuild(["build"], "/selected/project", {
      outputMode,
      runProcess: async () => {
        calls++;
        return calls === 1
          ? { status: "exited", exitCode: 65, stdout: "later output", stderr: "", logFilePath }
          : success;
      },
    });
    for (let turns = 0; process.listenerCount("SIGTERM") === listeners.SIGTERM.length; turns++) {
      assert.ok(turns < 1_000, "diagnostic scan should reach the retry delay");
      await setImmediate();
    }
    assert.equal(calls, 1);
    context.mock.timers.tick(1_000);
    assert.equal(await pending, "built");
    assert.equal(calls, 2);
    assert.equal(await readFile(logFilePath, "utf8"), output);
    assert.deepEqual(nativeListeners(), listeners);
  });
}

void test("keeps the native failure when the diagnostic log cannot be read", async () => {
  let calls = 0;
  await assert.rejects(
    runXcodeBuild(["build"], "/selected/project", {
      outputMode: "quiet",
      runProcess: async () => {
        calls++;
        return {
          status: "exited",
          exitCode: 65,
          stdout: "native failure",
          stderr: "",
          logFilePath: path.join(os.tmpdir(), "compile-missing-directory", "missing.log"),
        };
      },
    }),
    (error) =>
      error instanceof CompileError &&
      error.exitCode === 65 &&
      error.message.includes("native failure"),
  );
  assert.equal(calls, 1);
});

function nativeListeners() {
  return {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
    SIGHUP: process.listeners("SIGHUP"),
  };
}
