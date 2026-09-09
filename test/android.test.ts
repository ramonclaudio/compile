import assert from "node:assert/strict";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileAndroid,
  copyAndroidArtifacts,
  createGradleCommand,
  parseAndroidArtifactReport,
  resolveGradleWrapper,
  verifyAndroidArtifactPaths,
} from "../src/android.ts";
import { runProcess } from "../src/process.ts";
import { CompileError } from "../src/types.ts";
import { copyFixture } from "./fixtures.ts";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixtureDirectory = path.join(packageRoot, "fixtures", "android-java");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const hasAndroidSdk =
  process.env.ANDROID_HOME !== undefined || process.env.ANDROID_SDK_ROOT !== undefined;

void test("finds one Gradle Wrapper", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-gradle-wrapper-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const androidDirectory = path.join(projectDirectory, "android");
  await mkdir(androidDirectory);
  await writeFile(path.join(androidDirectory, "gradlew"), "#!/bin/sh\n");

  assert.deepEqual(await resolveGradleWrapper(projectDirectory, "darwin"), {
    cwd: androidDirectory,
    path: path.join(androidDirectory, "gradlew"),
  });

  await writeFile(path.join(projectDirectory, "gradlew"), "#!/bin/sh\n");
  await assert.rejects(
    resolveGradleWrapper(projectDirectory, "darwin"),
    /Found more than one gradlew/,
  );
});

void test("creates direct and Windows Gradle commands", () => {
  const args = ["task", "--console=plain"];
  assert.deepEqual(createGradleCommand("/project/gradlew", args, "darwin"), {
    command: "/project/gradlew",
    args,
  });
  assert.deepEqual(
    createGradleCommand(
      "C:\\project\\gradlew.bat",
      args,
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", "C:\\project\\gradlew.bat", ...args],
    },
  );
});

void test("finds the root Gradle Wrapper when android is a regular file", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-wrapper-file-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const wrapper = path.join(projectDirectory, "gradlew");
  await writeFile(wrapper, "#!/bin/sh\n");
  await writeFile(path.join(projectDirectory, "android"), "unrelated file");

  assert.deepEqual(await resolveGradleWrapper(projectDirectory, "darwin"), {
    cwd: projectDirectory,
    path: wrapper,
  });
});

void test("parses APK arrays and one AAB", () => {
  assert.deepEqual(
    parseAndroidArtifactReport(JSON.stringify({ paths: ["/tmp/x86.apk", "/tmp/arm.apk"] }), "apk"),
    ["/tmp/arm.apk", "/tmp/x86.apk"],
  );
  assert.deepEqual(parseAndroidArtifactReport(JSON.stringify({ paths: ["/tmp/app.aab"] }), "aab"), [
    "/tmp/app.aab",
  ]);
  assert.throws(
    () =>
      parseAndroidArtifactReport(
        JSON.stringify({ paths: ["/tmp/one.aab", "/tmp/two.aab"] }),
        "aab",
      ),
    /invalid artifact data/,
  );
  assert.throws(
    () => parseAndroidArtifactReport(JSON.stringify({ paths: ["relative/app.apk"] }), "apk"),
    /invalid artifact data/,
  );
});

void test("reports an artifact missing after Gradle succeeds", async () => {
  await assert.rejects(
    verifyAndroidArtifactPaths(["/tmp/compile-missing.apk"], "apk"),
    (error) => error instanceof CompileError && /Gradle exited with code 0/.test(error.message),
  );
});

for (const outputType of ["apk", "aab"] as const) {
  void test(`rejects an empty ${outputType} after Gradle succeeds`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-empty-artifact-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const artifact = path.join(directory, `App.${outputType}`);
    await writeFile(artifact, "");

    await assert.rejects(
      verifyAndroidArtifactPaths([artifact], outputType),
      (error) => error instanceof CompileError && /not a nonempty/.test(error.message),
    );

    await writeFile(artifact, "artifact");
    await verifyAndroidArtifactPaths([artifact], outputType);
  });
}

void test(
  "handles copy failure before cleaning the Gradle report",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-copy-rejection-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await writeFile(
      path.join(directory, "gradlew"),
      `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const path = require("node:path");
writeFileSync(process.env.COMPILE_ANDROID_REPORT, JSON.stringify({ paths: [path.join(process.cwd(), "App.apk")] }));
writeFileSync("report-directory.txt", path.dirname(process.env.COMPILE_ANDROID_REPORT));
`,
      { mode: 0o755 },
    );
    await writeFile(path.join(directory, "App.apk"), "artifact");
    const output = path.join(directory, "output");
    await writeFile(output, "existing file");

    await assert.rejects(
      compileAndroid({
        platform: "android",
        cwd: directory,
        mode: "development",
        outputType: "apk",
        outputDir: output,
      }),
      (error: unknown) => {
        assert(error instanceof CompileError);
        assert.match(error.message, /Could not use output directory/);
        assert(error.cause instanceof Error && "code" in error.cause);
        assert.equal(error.cause.code, "EEXIST");
        return true;
      },
    );

    assert.equal(await readFile(output, "utf8"), "existing file");
    const reportDirectory = await readFile(path.join(directory, "report-directory.txt"), "utf8");
    await assert.rejects(access(reportDirectory), { code: "ENOENT" });
  },
);

void test("copies an Android artifact over an existing file", async (context) => {
  const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-android-copy-"));
  context.after(() => rm(testDirectory, { force: true, recursive: true }));
  const sourcePath = path.join(testDirectory, "source", "app.apk");
  const outputDir = path.join(testDirectory, "output");
  const outputPath = path.join(outputDir, "app.apk");
  await mkdir(path.dirname(sourcePath));
  await mkdir(outputDir);
  await writeFile(sourcePath, "new artifact");
  await writeFile(outputPath, "old artifact");

  assert.deepEqual(await copyAndroidArtifacts([sourcePath], outputDir, "apk"), [outputPath]);
  assert.equal(await readFile(outputPath, "utf8"), "new artifact");
  assert.deepEqual(await readdir(outputDir), ["app.apk"]);
});

void test(
  "rejects flavored variants without a fixed standalone variant name",
  { skip: !hasAndroidSdk },
  async (context) => {
    const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-android-variants-"));
    context.after(() => rm(testDirectory, { force: true, recursive: true }));
    const projectDirectory = path.join(testDirectory, "project");
    await copyFixture(fixtureDirectory, projectDirectory);
    await appendFile(
      path.join(projectDirectory, "app", "build.gradle"),
      `
android {
  flavorDimensions "tier"
  productFlavors {
    free { dimension "tier" }
    paid { dimension "tier" }
  }
}
`,
    );

    const processResult = await runCli(["android", "--dev"], projectDirectory);
    assert.equal(processResult.status, "exited");
    assert.equal(processResult.exitCode, 1);
    assert.match(processResult.stderr, /Compile found no Android application variant named debug/);
    assert.match(processResult.stderr, /:app:freeDebug/);
    assert.match(processResult.stderr, /:app:paidDebug/);
  },
);

void test(
  "builds every Android mode and output with the Gradle Wrapper",
  { skip: !hasAndroidSdk },
  async (context) => {
    const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-android-output-"));
    context.after(() => rm(testDirectory, { force: true, recursive: true }));
    const projectDirectory = path.join(testDirectory, "project");
    const outputDir = path.join(testDirectory, "output");
    await copyFixture(fixtureDirectory, projectDirectory);

    const apkResult = await runCli(
      ["android", "--dev", "--output-dir", outputDir],
      projectDirectory,
    );
    assert.equal(apkResult.status, "exited");
    assert.equal(apkResult.exitCode, 0, apkResult.stderr);
    assert.equal(apkResult.stderr, "");
    const apkPaths = readOutputPaths(apkResult.stdout);
    assert.equal(apkPaths.length, 3);
    for (const apkPath of apkPaths) {
      assert.equal(path.dirname(apkPath), outputDir);
      assert.equal(path.extname(apkPath), ".apk");
      assert.match(path.basename(apkPath), /-debug\.apk$/);
      await access(apkPath);
    }

    const cachedApkResult = await runCli(
      ["android", "--dev", "--output-dir", outputDir],
      projectDirectory,
    );
    assert.equal(cachedApkResult.status, "exited");
    assert.equal(cachedApkResult.exitCode, 0, cachedApkResult.stderr);
    assert.equal(cachedApkResult.stderr, "");
    assert.deepEqual(readOutputPaths(cachedApkResult.stdout), apkPaths);

    const productionApkResult = await runCli(
      ["android", "--prod", "--output-dir", outputDir],
      projectDirectory,
    );
    assert.equal(productionApkResult.status, "exited");
    assert.equal(productionApkResult.exitCode, 0, productionApkResult.stderr);
    assert.equal(productionApkResult.stderr, "");
    const productionApkPaths = readOutputPaths(productionApkResult.stdout);
    assert.equal(productionApkPaths.length, 3);
    for (const apkPath of productionApkPaths) {
      assert.match(path.basename(apkPath), /-release(?:-unsigned)?\.apk$/);
      await access(apkPath);
    }

    const developmentAabResult = await runCli(
      ["android", "--dev", "--output-type", "aab", "--output-dir", outputDir],
      projectDirectory,
    );
    assert.equal(developmentAabResult.status, "exited");
    assert.equal(developmentAabResult.exitCode, 0, developmentAabResult.stderr);
    assert.equal(developmentAabResult.stderr, "");
    const developmentAabPaths = readOutputPaths(developmentAabResult.stdout);
    assert.equal(developmentAabPaths.length, 1);
    const [developmentAabPath] = developmentAabPaths;
    assert.ok(developmentAabPath !== undefined);
    assert.match(path.basename(developmentAabPath), /-debug\.aab$/);
    await access(developmentAabPath);

    const aabResult = await runCli(
      ["android", "--prod", "--output-type", "aab", "--output-dir", outputDir],
      projectDirectory,
    );
    assert.equal(aabResult.status, "exited");
    assert.equal(aabResult.exitCode, 0, aabResult.stderr);
    assert.equal(aabResult.stderr, "");
    const aabPaths = readOutputPaths(aabResult.stdout);
    assert.equal(aabPaths.length, 1);
    const [aabPath] = aabPaths;
    assert.ok(aabPath !== undefined);
    assert.equal(path.extname(aabPath), ".aab");
    await access(aabPath);
  },
);

void test("rejects malformed Android artifact reports", () => {
  for (const input of [
    "",
    "{",
    "null",
    "[]",
    "{}",
    '{"paths":null}',
    '{"paths":[1]}',
    '{"paths":[]}',
    '{"paths":["relative.apk"]}',
    '{"paths":["/tmp/a.aab"]}',
    '{"paths":["/tmp/a.apk","/tmp/a.apk"]}',
  ]) {
    assert.throws(() => parseAndroidArtifactReport(input, "apk"), /invalid artifact data/, input);
  }
});

function runCli(args: readonly string[], cwd: string) {
  return runProcess(process.execPath, [cliPath, ...args], {
    cwd,
    env: undefined,
    outputMode: "capture",
    signal: undefined,
  });
}

function readOutputPaths(output: string): readonly string[] {
  assert.ok(output.endsWith("\n"), output);
  const paths = output.slice(0, -1).split("\n");
  for (const outputPath of paths) {
    assert.ok(path.isAbsolute(outputPath), outputPath);
  }
  return paths;
}

for (const [mode, variant, debuggable] of [
  ["--dev", "debug", false],
  ["--prod", "release", true],
] as const) {
  void test(
    `builds ${variant} for ${mode} when native debuggable is ${debuggable}`,
    { skip: !hasAndroidSdk },
    async (context) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "compile-native-debuggable-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      await copyFixture(fixtureDirectory, root);
      await appendFile(
        path.join(root, "app", "build.gradle"),
        `
android.buildTypes.configureEach { debuggable = ${debuggable} }
`,
      );
      const result = await runCli(["android", mode], root);
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, "");
      const artifacts = readOutputPaths(result.stdout);
      assert.equal(artifacts.length, 3);
      for (const artifact of artifacts) {
        assert.ok(
          path.basename(artifact).endsWith(`-${variant}.apk`) ||
            path.basename(artifact).endsWith(`-${variant}-unsigned.apk`),
        );
        const bytes = await readFile(artifact);
        assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      }
    },
  );
}

for (const [mode, variant, debuggable] of [
  ["--dev", "debug", true],
  ["--prod", "release", false],
] as const) {
  void test(
    `rejects a unique custom Android variant for ${mode}`,
    { skip: !hasAndroidSdk },
    async (context) => {
      const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-custom-only-"));
      context.after(() => rm(project, { recursive: true, force: true }));
      await copyFixture(fixtureDirectory, project);
      await appendFile(
        path.join(project, "app", "build.gradle"),
        `
android.buildTypes.debugOptimized.debuggable = ${debuggable}
androidComponents.beforeVariants(androidComponents.selector().all()) { variant ->
  variant.enable = variant.name == "debugOptimized"
}
`,
      );
      const result = await runCli(["android", mode], project);
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.ok(
        result.stderr.includes(
          `Compile found no Android application variant named ${variant}. Available variants: :app:debugOptimized`,
        ),
        result.stderr,
      );
    },
  );
}

void test(
  "rejects fixed Android variant names found in multiple application modules",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-multiple-modules-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixtureDirectory, project);
    await copyFixture(path.join(fixtureDirectory, "app"), path.join(project, "other"));
    await appendFile(path.join(project, "settings.gradle"), '\ninclude ":other"\n');
    for (const [mode, variant] of [
      ["--dev", "debug"],
      ["--prod", "release"],
    ] as const) {
      const result = await runCli(["android", mode], project);
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.ok(
        result.stderr.includes(`Compile found 2 Android application variants named ${variant}:`),
        result.stderr,
      );
      assert.ok(result.stderr.includes(`:app:${variant}`), result.stderr);
      assert.ok(result.stderr.includes(`:other:${variant}`), result.stderr);
    }
  },
);
