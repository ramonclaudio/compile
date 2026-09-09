import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runProcess } from "../src/process.ts";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const invalidArguments = [
  [],
  ["web", "--dev"],
  ["ios"],
  ["android"],
  ["ios", "android", "--dev"],
  ["ios", "--dev=false"],
  ["android", "--no-dev"],
  ["ios", "--dev", "--output-dir"],
  ["android", "--dev", "--output-type"],
  ["ios", "--dev", "--output-type="],
  ["android", "--dev", "--output-type="],
  ["ios", "--dev", "--output-type", "ipa"],
  ["ios", "--dev", "--output-type", "apk"],
  ["android", "--dev", "--output-type", "app"],
  ["android", "--dev", "--output-type", "APK"],
  ["android", "--dev", "--device"],
  ["android", "--prod", "--device=generic"],
  ["ios", "--dev", "--device="],
  ["ios", "--dev", "--device=id,platform=iOS"],
  ["ios", "--dev", "--device", "a b"],
  ["ios", "--dev", "--", "--device"],
  ["android", "--dev", "extra"],
];

for (const platform of ["ios", "android"]) {
  for (const development of ["--dev", "--development"]) {
    for (const production of ["--prod", "--production"]) {
      invalidArguments.push([platform, development, production]);
    }
  }
  for (const option of [
    "--scheme",
    "--configuration",
    "--variant",
    "--json",
    "--project",
    "--workspace",
  ]) {
    invalidArguments.push([platform, "--dev", option, "example"]);
  }
}

for (const args of invalidArguments) {
  void test(`CLI rejects ${JSON.stringify(args)} without creating output`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-error-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const result = await runCli(args, directory);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 64, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^compile: /);
    assert.deepEqual(await readdir(directory), []);
  });
}

for (const args of [["--help"], ["ios", "--help"], ["android", "--help"]]) {
  void test(`CLI shows help for ${args.join(" ")}`, async () => {
    const result = await runCli(args, os.tmpdir());
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /compile ios/);
    assert.match(result.stdout, /compile android/);
    assert.doesNotMatch(result.stdout, /--scheme|--configuration|--variant/);
  });
}

for (const mode of ["--dev", "--development", "--prod", "--production"]) {
  void test(`CLI accepts ${mode} and reports a missing Android project`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-missing-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const result = await runCli(["android", mode], directory);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No gradlew(?:\.bat)? found/);
    assert.deepEqual(await readdir(directory), []);
  });
}

void test("CLI handles repeated device flags and preserves arguments after --", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-device-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [args, exitCode, message] of [
    [
      ["ios", "--dev", "--device", "first-device", "--device"],
      1,
      process.platform === "darwin"
        ? /No Xcode project or workspace found/
        : /requires macOS and Xcode/,
    ],
    [["ios", "--dev", "--", "--device"], 64, /Unexpected argument "--device"\./],
  ] as const) {
    const result = await runCli(args, directory);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, exitCode, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    assert.deepEqual(await readdir(directory), []);
  }
});

void test("CLI rejects ambiguous wrappers before invoking either one", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-ambiguous-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  await mkdir(path.join(directory, "android"));
  await writeFile(path.join(directory, wrapper), "must not execute");
  await writeFile(path.join(directory, "android", wrapper), "must not execute");
  const result = await runCli(["android", "--dev"], directory);
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Found more than one gradlew/);
});

void test("CLI prints only artifact paths after a successful build", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-output-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const firstArtifact = path.join(directory, "first app.apk");
  const secondArtifact = path.join(directory, "second app.apk");
  await writeFile(firstArtifact, "artifact fixture");
  await writeFile(secondArtifact, "artifact fixture");
  await writeGradleFixture(
    directory,
    [
      'import { writeFileSync } from "node:fs";',
      'console.log("native stdout");',
      'console.error("native stderr");',
      `writeFileSync(process.env.COMPILE_ANDROID_REPORT, ${JSON.stringify(JSON.stringify({ paths: [firstArtifact, secondArtifact] }))});`,
    ].join("\n"),
  );

  const result = await runCli(["android", "--dev"], directory);
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, `${firstArtifact}\n${secondArtifact}\n`);
  assert.equal(result.stderr, "");
});

void test("CLI preserves a native failure's exit code and output", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-exit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeGradleFixture(
    directory,
    [
      'console.log("native stdout");',
      'process.stderr.write("native stderr");',
      "process.exitCode = 23;",
    ].join("\n"),
  );

  const result = await runCli(["android", "--dev"], directory);
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 23, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "compile: Gradle failed with exit code 23:\nnative stdout\nnative stderr\n",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  void test(
    `CLI preserves native termination by ${signal}`,
    { skip: process.platform === "win32" },
    async (context) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-signal-"));
      context.after(() => rm(directory, { recursive: true, force: true }));
      await writeGradleFixture(directory, `process.kill(process.pid, ${JSON.stringify(signal)});`);

      const result = await runCli(["android", "--dev"], directory);
      assert.equal(result.status, "signaled");
      assert.equal(result.signal, signal);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `compile: Gradle stopped after receiving ${signal}.\n`);
    },
  );
}

void test(
  "CLI preserves native diagnostics when a build is terminated",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-cli-signal-output-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await writeGradleFixture(
      directory,
      [
        'import { writeSync } from "node:fs";',
        'writeSync(1, "native stdout\\n");',
        'writeSync(2, "native stderr\\n");',
        'process.kill(process.pid, "SIGTERM");',
      ].join("\n"),
    );

    const result = await runCli(["android", "--dev"], directory);
    assert.equal(result.status, "signaled");
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "compile: Gradle stopped after receiving SIGTERM:\nnative stdout\nnative stderr\n",
    );
  },
);

void test(
  "prints a stack for an unexpected CLI error",
  { skip: process.platform === "win32" },
  async () => {
    const script = [
      'import { mkdtempSync, rmSync } from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'const cwd = mkdtempSync(path.join(os.tmpdir(), "compile-missing-cwd-"));',
      "process.chdir(cwd);",
      "rmSync(cwd, { recursive: true });",
      `process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "ios", "--dev"];`,
      `await import(${JSON.stringify(pathToFileURL(cliPath).href)});`,
    ].join("");
    const processResult = await runProcess(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: os.tmpdir(), env: undefined, outputMode: "capture", signal: undefined },
    );

    assert.equal(processResult.status, "exited");
    assert.equal(processResult.exitCode, 1);
    assert.equal(processResult.stdout, "");
    assert.match(processResult.stderr, /^compile: Error: ENOENT:/);
    assert.match(processResult.stderr, /\n\s+at /);
  },
);

function runCli(args: readonly string[], cwd: string) {
  return runProcess(process.execPath, [cliPath, ...args], {
    cwd,
    env: undefined,
    outputMode: "capture",
    signal: undefined,
  });
}

async function writeGradleFixture(directory: string, script: string): Promise<void> {
  await writeFile(path.join(directory, "gradle.mjs"), script);
  const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapper =
    process.platform === "win32"
      ? '@echo off\r\nnode "%~dp0gradle.mjs" %*\r\n'
      : '#!/bin/sh\nexec node "$(dirname "$0")/gradle.mjs" "$@"\n';
  await writeFile(path.join(directory, wrapperName), wrapper, { mode: 0o755 });
}

void test(
  "CLI explains a nonexecutable Gradle Wrapper",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-wrapper-permissions-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const wrapper = path.join(directory, "gradlew");
    await writeFile(wrapper, "#!/bin/sh\nexit 0\n");
    await chmod(wrapper, 0o644);
    const result = await runCli(["android", "--dev"], directory);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Cannot execute Gradle Wrapper/);
    assert.match(result.stderr, /chmod \+x/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  },
);

void test("CLI reports an unusable output directory without a stack or lost files", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-output-error-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "App.apk");
  const output = path.join(directory, "output");
  await writeFile(source, "built artifact");
  await writeFile(output, "keep this file");
  await writeGradleFixture(
    directory,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(process.env.COMPILE_ANDROID_REPORT, ${JSON.stringify(JSON.stringify({ paths: [source] }))});`,
    ].join("\n"),
  );
  const result = await runCli(["android", "--dev", "--output-dir", output], directory);
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Could not use output directory/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(await readFile(source, "utf8"), "built artifact");
  assert.equal(await readFile(output, "utf8"), "keep this file");
});

for (const platform of ["linux", "win32"]) {
  void test(`CLI explains the iOS host requirement on ${platform}`, async () => {
    const script = [
      `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
      `process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "ios", "--dev"];`,
      `await import(${JSON.stringify(pathToFileURL(cliPath).href)});`,
    ].join("\n");
    const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], {
      cwd: os.tmpdir(),
      env: undefined,
      outputMode: "capture",
      signal: undefined,
    });
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "compile: Compiling iOS apps requires macOS and Xcode.\n");
  });
}
