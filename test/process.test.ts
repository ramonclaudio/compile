import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

void test("preserves a captured stdout error when stderr also contains a warning", async () => {
  await assert.rejects(
    runCheckedProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("missing source file\\n"); process.stderr.write("unrelated warning\\n"); process.exitCode = 65;',
      ],
      captureOptions,
      "Native metadata",
    ),
    {
      exitCode: 65,
      message: "Native metadata failed with exit code 65:\nmissing source file\nunrelated warning",
    },
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

for (const outputMode of ["stderr", "quiet"] as const) {
  void test(`keeps native output off stdout in ${outputMode} mode`, async () => {
    const outputSize = 256 * 1_024;
    const childScript = `process.stdout.write("o".repeat(${outputSize})); process.stderr.write("e".repeat(${outputSize}))`;
    const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
    const parentScript = [
      `import { runProcess } from ${JSON.stringify(processModuleUrl)};`,
      `const result = await runProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: ${JSON.stringify(outputMode)}, signal: undefined });`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("");
    const processResult = await runProcess(
      process.execPath,
      ["--input-type=module", "-e", parentScript],
      captureOptions,
    );

    assert.equal(processResult.status, "exited");
    assert.equal(processResult.exitCode, 0, processResult.stderr);
    if (outputMode === "stderr") {
      assert.ok(processResult.stderr.endsWith("\n"));
      const forwarded = processResult.stderr.slice(0, -1);
      assert.equal(forwarded.length, outputSize * 2);
      assert.equal(forwarded.replaceAll("o", "").length, outputSize);
      assert.equal(forwarded.replaceAll("e", "").length, outputSize);
    } else {
      assert.equal(processResult.stderr, "");
    }
    assert.deepEqual(JSON.parse(processResult.stdout), {
      status: "exited",
      exitCode: 0,
      stdout: "o".repeat(16 * 1_024),
      stderr: "e".repeat(16 * 1_024),
    });
  });
}

for (const outputMode of ["stderr", "quiet"] as const) {
  void test(`bounds failure diagnostic lines in ${outputMode} mode`, async (context) => {
    const lines =
      Array.from({ length: 100 }, (_, index) => `native line ${index}`).join("\n") + "\n";
    const childScript = `process.stderr.write(${JSON.stringify(lines)}); process.exitCode = 65`;
    const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
    const script = [
      `import { runCheckedProcess } from ${JSON.stringify(processModuleUrl)};`,
      "try {",
      `await runCheckedProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: ${JSON.stringify(outputMode)}, signal: undefined }, "Native build");`,
      "} catch (error) { process.stdout.write(JSON.stringify({ message: error.message, exitCode: error.exitCode, logFilePath: error.logFilePath })); }",
    ].join("\n");
    const result = await runProcess(
      process.execPath,
      ["--input-type=module", "-e", script],
      captureOptions,
    );
    assert.equal(result.status, "exited");
    assert.equal(result.stderr, outputMode === "stderr" ? lines : "");
    const failure: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(failure));
    const logSuffix = await verifyFailureLog(context, failure, outputMode, lines);
    assert.deepEqual(failure, {
      exitCode: 65,
      message: `Native build failed with exit code 65:\n${lines.trimEnd().split("\n").slice(-30).join("\n")}${logSuffix}`,
      logFilePath: failure.logFilePath,
    });
  });
}

for (const outputMode of ["stderr", "quiet"] as const) {
  void test(`bounds long UTF-8 diagnostics in ${outputMode} mode`, async (context) => {
    const output = "😀".repeat(10_000) + "final native diagnostic";
    const childScript =
      'process.stdout.write("😀".repeat(10_000) + "final native diagnostic"); process.exitCode = 23';
    const processModuleUrl = new URL("../dist/process.js", import.meta.url).href;
    const script = [
      `import { runCheckedProcess } from ${JSON.stringify(processModuleUrl)};`,
      "try {",
      `await runCheckedProcess(process.execPath, ["-e", ${JSON.stringify(childScript)}], { cwd: process.cwd(), env: undefined, outputMode: ${JSON.stringify(outputMode)}, signal: undefined }, "Native build");`,
      "} catch (error) { process.stdout.write(JSON.stringify({ message: error.message, exitCode: error.exitCode, logFilePath: error.logFilePath })); }",
    ].join("\n");
    const result = await runProcess(
      process.execPath,
      ["--input-type=module", "-e", script],
      captureOptions,
    );
    assert.equal(result.status, "exited");
    assert.equal(result.stderr, outputMode === "stderr" ? `${output}\n` : "");
    const failure: unknown = JSON.parse(result.stdout);
    assert.ok(isRecord(failure));
    assert.equal(failure.exitCode, 23);
    assert.ok(typeof failure.message === "string");
    const prefix = "Native build failed with exit code 23:\n";
    assert.ok(failure.message.startsWith(prefix));
    const logSuffix = await verifyFailureLog(context, failure, outputMode, output);
    const tail = failure.message.slice(prefix.length, failure.message.length - logSuffix.length);
    assert.ok(Buffer.byteLength(tail) <= 16 * 1_024);
    assert.ok(tail.endsWith("final native diagnostic"));
    assert.ok(!tail.includes("\uFFFD"));
    assert.ok(tail.startsWith("😀"));
  });
}

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

void test("quiet failures preserve early diagnostics from both streams in a private complete log", async (context) => {
  const stdout = "first stdout error\n" + "later stdout noise\n".repeat(100_000);
  const stderr = "first stderr error\n" + "later stderr noise\n".repeat(100_000);
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      'process.stdout.write("first stdout error\\n" + "later stdout noise\\n".repeat(100_000)); process.stderr.write("first stderr error\\n" + "later stderr noise\\n".repeat(100_000)); process.exitCode = 65;',
    ],
    { ...captureOptions, outputMode: "quiet" },
  );
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 65);
  assert.ok(result.logFilePath);
  const logFilePath = result.logFilePath;
  context.after(() => rm(path.dirname(logFilePath), { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1_024);
  assert.ok(Buffer.byteLength(result.stderr) <= 16 * 1_024);
  assert.doesNotMatch(result.stdout + result.stderr, /first (?:stdout|stderr) error/);
  const log = await readFile(result.logFilePath, "utf8");
  assert.equal(log, stdout + "\n" + stderr);
  assert.ok(log.includes("first stdout error\n"));
  assert.ok(log.includes("first stderr error\n"));
  assert.equal(log.split("later stdout noise\n").length - 1, 100_000);
  assert.equal(log.split("later stderr noise\n").length - 1, 100_000);
  if (!isWindows) {
    assert.equal((await stat(result.logFilePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(result.logFilePath))).mode & 0o777, 0o700);
  }
});

void test("keeps a diagnostic contiguous when stderr arrives between stdout chunks", async (context) => {
  const result = await runProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { writeSync } from "node:fs";',
        'import { setTimeout } from "node:timers/promises";',
        'writeSync(1, "database is ");',
        "await setTimeout(20);",
        'writeSync(2, "unrelated warning\\n");',
        "await setTimeout(20);",
        'writeSync(1, "locked\\n" + "later output\\n".repeat(100));',
        "process.exitCode = 65;",
      ].join("\n"),
    ],
    { ...captureOptions, outputMode: "quiet" },
  );
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 65);
  assert.ok(result.logFilePath);
  const logFilePath = result.logFilePath;
  context.after(() => rm(path.dirname(logFilePath), { recursive: true, force: true }));
  assert.equal(
    await readFile(logFilePath, "utf8"),
    "database is locked\n" + "later output\n".repeat(100) + "\nunrelated warning\n",
  );
});

for (const outcome of [
  "success",
  "short-failure",
  "spawn-error",
  "invalid-arguments",
  "pre-aborted",
] as const) {
  void test(`cleans quiet output logs after ${outcome}`, async (context) => {
    const directory = await temporaryDirectory(context);
    const childCode =
      outcome === "success"
        ? 'process.stdout.write("long successful output\\n".repeat(100));'
        : 'process.stderr.write("short failure"); process.exitCode = 17;';
    const command = outcome === "spawn-error" ? "/compile-test/missing-command" : process.execPath;
    const args = outcome === "invalid-arguments" ? ["\0"] : ["-e", childCode];
    const script = [
      `const options = { cwd: process.cwd(), env: undefined, outputMode: "quiet", signal: ${outcome === "pre-aborted" ? "AbortSignal.abort()" : "undefined"} };`,
      `try { console.log(JSON.stringify(await runProcess(${JSON.stringify(command)}, ${JSON.stringify(args)}, options))); }`,
      "catch (error) { console.log(JSON.stringify({ error: error.message, signal: error.signal, code: error.code ?? error.cause?.code })); }",
    ].join("\n");
    const result = await runLogProbe(directory, script);
    assert.equal(result.logFilePath, undefined);
    assert.deepEqual(await readdir(directory), []);
    if (outcome === "success") assert.equal(result.exitCode, 0);
    if (outcome === "short-failure") assert.equal(result.exitCode, 17);
    if (outcome === "spawn-error") assert.equal(result.code, "ENOENT");
    if (outcome === "invalid-arguments") assert.equal(result.code, "ERR_INVALID_ARG_VALUE");
    if (outcome === "pre-aborted") assert.equal(result.signal, "SIGTERM");
  });
}

void test("keeps a quiet failure's native status when its log directory cannot be created", async (context) => {
  const root = await temporaryDirectory(context);
  const blockedDirectory = path.join(root, "file-not-directory");
  await writeFile(blockedDirectory, "occupied");
  const child =
    'process.stdout.write("original error\\n" + "later noise\\n".repeat(100)); process.exitCode = 29;';
  const result = await runLogProbe(
    blockedDirectory,
    [
      `try { await runCheckedProcess(process.execPath, ["-e", ${JSON.stringify(child)}], { cwd: process.cwd(), env: undefined, outputMode: "quiet", signal: undefined }, "Native build"); }`,
      "catch (error) { console.log(JSON.stringify({ message: error.message, exitCode: error.exitCode, logFilePath: error.logFilePath })); }",
    ].join("\n"),
  );
  assert.equal(result.exitCode, 29);
  assert.equal(result.logFilePath, undefined);
  assert.ok(typeof result.message === "string");
  assert.match(result.message, /Native build failed with exit code 29/);
  assert.match(result.message, /Could not save full native output:.*ENOTDIR/);
  assert.equal(await readFile(blockedDirectory, "utf8"), "occupied");
});

void test("drains a native child and preserves its exit after a log write fails", async (context) => {
  const directory = await temporaryDirectory(context);
  const child =
    'process.stdout.write("o".repeat(4 * 1024 * 1024)); process.stderr.write("e".repeat(4 * 1024 * 1024)); process.exitCode = 37;';
  const script = [
    'const { default: fs } = await import("node:fs");',
    'const { syncBuiltinESMExports } = await import("node:module");',
    "const originalCreateWriteStream = fs.createWriteStream;",
    'fs.createWriteStream = (file, options) => originalCreateWriteStream(file, { ...options, fs: { ...fs, write(...args) { args.at(-1)(Object.assign(new Error("simulated disk full"), { code: "ENOSPC" })); }, writev(...args) { args.at(-1)(Object.assign(new Error("simulated disk full"), { code: "ENOSPC" })); } } });',
    "syncBuiltinESMExports();",
    `try { await runCheckedProcess(process.execPath, ["-e", ${JSON.stringify(child)}], { cwd: process.cwd(), env: undefined, outputMode: "quiet", signal: undefined }, "Native build"); }`,
    "catch (error) { console.log(JSON.stringify({ message: error.message, exitCode: error.exitCode, logFilePath: error.logFilePath })); }",
  ].join("\n");
  const result = await withTimeout(
    runLogProbe(directory, script),
    "native output after log failure",
  );
  assert.equal(result.exitCode, 37);
  assert.equal(result.logFilePath, undefined);
  assert.ok(typeof result.message === "string");
  assert.match(result.message, /Could not save full native output: simulated disk full/);
  assert.deepEqual(await readdir(directory), []);
});

void test(
  "retains full quiet output when an AbortSignal cancels a noisy native child",
  { skip: isWindows },
  async (context) => {
    const directory = await temporaryDirectory(context);
    const ready = path.join(directory, "ready");
    const controller = new AbortController();
    const script = [
      'const fs = require("node:fs");',
      'fs.writeSync(1, "early cancellation diagnostic\\n" + "later noise\\n".repeat(100));',
      'process.on("SIGTERM", () => process.exit(0));',
      `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const pending = runCheckedProcess(
      process.execPath,
      ["-e", script],
      { ...captureOptions, outputMode: "quiet", signal: controller.signal },
      "Native build",
    );
    context.after(() => controller.abort());
    await readReadyPid(ready);
    controller.abort();
    let failure: CompileError | undefined;
    await assert.rejects(withTimeout(pending, "cancelled logged child"), (error: unknown) => {
      assert.ok(error instanceof CompileError);
      failure = error;
      assert.equal(error.signal, "SIGTERM");
      assert.ok(error.logFilePath);
      return true;
    });
    assert.ok(failure?.logFilePath);
    const logFilePath = failure.logFilePath;
    context.after(() => rm(path.dirname(logFilePath), { recursive: true, force: true }));
    assert.equal(
      await readFile(logFilePath, "utf8"),
      "early cancellation diagnostic\n" + "later noise\n".repeat(100),
    );
    assert.ok(failure.message.endsWith(`Full native output saved to ${logFilePath}`));
  },
);

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

async function verifyFailureLog(
  context: TestContext,
  failure: Record<string, unknown>,
  outputMode: "stderr" | "quiet",
  expectedOutput: string,
): Promise<string> {
  const logFilePath = failure.logFilePath;
  assert.ok(typeof logFilePath === "string", `Missing ${outputMode} failure log.`);
  assert.equal(path.basename(logFilePath), "native.log");
  assert.match(path.basename(path.dirname(logFilePath)), /^compile-output-/);
  context.after(() => rm(path.dirname(logFilePath), { recursive: true, force: true }));
  assert.equal(await readFile(logFilePath, "utf8"), expectedOutput);
  return `\nFull native output saved to ${logFilePath}`;
}

async function runLogProbe(directory: string, script: string): Promise<Record<string, unknown>> {
  const moduleUrl = new URL("../dist/process.js", import.meta.url).href;
  const result = await runProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { runProcess, runCheckedProcess } from ${JSON.stringify(moduleUrl)};\n${script}`,
    ],
    {
      ...captureOptions,
      env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
    },
  );
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(parsed));
  return parsed;
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
