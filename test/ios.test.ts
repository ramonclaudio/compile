import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  copyApps,
  parseAppPaths,
  resolveIosSource,
  resolveXcodeDestination,
  selectScheme,
  verifyAppPaths,
} from "../src/ios.ts";
import { runProcess } from "../src/process.ts";
import type { RunProcessOptions } from "../src/process.ts";
import { CompileError } from "../src/types.ts";
import { copyFixture } from "./fixtures.ts";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixtureDirectory = path.join(packageRoot, "fixtures", "ios-uikit");
const fixtureProjectPath = path.join(fixtureDirectory, "CompilePrototype.xcodeproj");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const isMacOS = process.platform === "darwin";
const isWindows = process.platform === "win32";

void test("maps generic and specific Xcode destinations", () => {
  assert.equal(resolveXcodeDestination({ kind: "simulator" }), "generic/platform=iOS Simulator");
  assert.equal(resolveXcodeDestination({ kind: "device" }), "generic/platform=iOS");
  assert.equal(
    resolveXcodeDestination({
      kind: "device",
      id: "00008110-001234567890001E",
    }),
    "id=00008110-001234567890001E",
  );
});

void test("rejects multiple Xcode projects", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-multiple-projects-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  await mkdir(path.join(projectDirectory, "First.xcodeproj"));
  await mkdir(path.join(projectDirectory, "Second.xcodeproj"));

  await assert.rejects(
    resolveIosSource(projectDirectory),
    (error) => error instanceof CompileError && /multiple Xcode projects/.test(error.message),
  );
});

void test("prefers a workspace in ios/ over a project in the root", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-nested-workspace-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  await mkdir(path.join(projectDirectory, "App.xcodeproj"));
  const workspace = path.join(projectDirectory, "ios", "App.xcworkspace");
  await mkdir(workspace, { recursive: true });

  assert.deepEqual(await resolveIosSource(projectDirectory), {
    kind: "workspace",
    path: workspace,
  });
});

void test("ignores internal workspaces and files named like Xcode bundles", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-source-entries-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  const project = path.join(projectDirectory, "App.xcodeproj");
  await mkdir(project);
  await mkdir(path.join(projectDirectory, "project.xcworkspace"));
  await mkdir(path.join(projectDirectory, "unrelated"));
  await writeFile(path.join(projectDirectory, "File.xcodeproj"), "");
  await writeFile(path.join(projectDirectory, "File.xcworkspace"), "");

  assert.deepEqual(await resolveIosSource(projectDirectory), {
    kind: "project",
    path: project,
  });
});

void test("rejects multiple Xcode workspaces across the root and ios/", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-multiple-workspaces-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  await mkdir(path.join(projectDirectory, "First.xcworkspace"));
  await mkdir(path.join(projectDirectory, "ios", "Second.xcworkspace"), { recursive: true });

  await assert.rejects(resolveIosSource(projectDirectory), /multiple Xcode workspaces/);
});

void test("selects the only Xcode scheme or one matching the source name", () => {
  const xcodeSource = {
    kind: "workspace",
    path: "/tmp/App.xcworkspace",
  } as const;

  assert.equal(selectScheme(["OnlyScheme"], xcodeSource), "OnlyScheme");
  assert.equal(selectScheme(["App", "Pods-App"], xcodeSource), "App");
  assert.throws(() => selectScheme([], xcodeSource), /No Xcode schemes found/);
  assert.throws(() => selectScheme(["First", "Second"], xcodeSource), /multiple Xcode schemes/);
});

void test("reports a missing app after xcodebuild succeeds", async () => {
  await assert.rejects(
    verifyAppPaths([path.join(os.tmpdir(), "compile-missing.app")]),
    (error) => error instanceof CompileError && /xcodebuild exited with code 0/.test(error.message),
  );
});

void test(
  "keeps an existing app when its replacement is invalid",
  { skip: !isMacOS },
  async (context) => {
    const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-copy-failure-"));
    context.after(() => rm(testDirectory, { force: true, recursive: true }));
    const sourcePath = path.join(testDirectory, "source", "App.app");
    const outputDir = path.join(testDirectory, "output");
    const outputPath = path.join(outputDir, "App.app");
    const markerPath = path.join(outputPath, "marker.txt");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "not an app directory");
    await mkdir(outputPath, { recursive: true });
    await writeFile(markerPath, "existing app");

    await assert.rejects(copyApps([sourcePath], outputDir, testDirectory), /not an app directory/);

    assert.equal(await readFile(markerPath, "utf8"), "existing app");
    assert.deepEqual(await readdir(outputDir), ["App.app"]);
  },
);

void test(
  "replaces an existing app after checking the copy",
  { skip: !isMacOS },
  async (context) => {
    const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-copy-success-"));
    context.after(() => rm(testDirectory, { force: true, recursive: true }));
    const sourcePath = path.join(testDirectory, "source", "App.app");
    const outputDir = path.join(testDirectory, "output");
    const outputPath = path.join(outputDir, "App.app");
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "marker.txt"), "new app");
    await mkdir(outputPath, { recursive: true });
    await writeFile(path.join(outputPath, "marker.txt"), "existing app");

    assert.deepEqual(await copyApps([sourcePath], outputDir, testDirectory), [outputPath]);
    assert.equal(await readFile(path.join(outputPath, "marker.txt"), "utf8"), "new app");
    assert.deepEqual(await readdir(outputDir), ["App.app"]);
  },
);

void test("rejects an output directory inside the source app", async (context) => {
  const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-copy-inside-source-"));
  context.after(() => rm(testDirectory, { force: true, recursive: true }));
  const sourcePath = path.join(testDirectory, "App.app");
  const outputDir = path.join(sourcePath, "output");
  await mkdir(sourcePath);

  await assert.rejects(copyApps([sourcePath], outputDir, testDirectory), /overlaps the source app/);
  await assert.rejects(access(outputDir));
});

void test("rejects an output app that contains the source app", async (context) => {
  const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-copy-containing-source-"));
  context.after(() => rm(testDirectory, { force: true, recursive: true }));
  const outputDir = path.join(testDirectory, "output");
  const sourcePath = path.join(outputDir, "App.app", "nested", "App.app");
  await mkdir(sourcePath, { recursive: true });

  await assert.rejects(copyApps([sourcePath], outputDir, testDirectory), /overlaps the source app/);
  await access(sourcePath);
});

void test("rejects an output app that contains another source app", async (context) => {
  const testDirectory = await mkdtemp(
    path.join(os.tmpdir(), "compile-copy-containing-other-source-"),
  );
  context.after(() => rm(testDirectory, { force: true, recursive: true }));
  const outputDir = path.join(testDirectory, "output");
  const firstApp = path.join(testDirectory, "First.app");
  const secondApp = path.join(outputDir, "First.app", "nested", "Second.app");
  const originalFile = path.join(secondApp, "original.txt");
  await mkdir(firstApp);
  await mkdir(secondApp, { recursive: true });
  await writeFile(originalFile, "keep this source");

  await assert.rejects(
    copyApps([firstApp, secondApp], outputDir, testDirectory),
    /overlaps the source app/,
  );
  assert.equal(await readFile(originalFile, "utf8"), "keep this source");
  assert.deepEqual(await readdir(outputDir), ["First.app"]);
});

void test("rejects an output path inside another source app", async (context) => {
  const testDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-copy-inside-other-source-"));
  context.after(() => rm(testDirectory, { force: true, recursive: true }));
  const firstApp = path.join(testDirectory, "First.app");
  const secondApp = path.join(testDirectory, "Second.app");
  await mkdir(firstApp);
  await mkdir(secondApp);

  await assert.rejects(
    copyApps([firstApp, secondApp], secondApp, testDirectory),
    /overlaps the source app/,
  );
  assert.deepEqual(await readdir(secondApp), []);
});

void test("returns app paths without enforcing optimization settings", () => {
  const xcodeOutput = JSON.stringify([
    {
      buildSettings: {
        CONFIGURATION: "Debug",
        PLATFORM_NAME: "iphonesimulator",
        IS_UNOPTIMIZED_BUILD: "YES",
        TARGET_BUILD_DIR: ".build/products",
        WRAPPER_NAME: "App.app",
      },
    },
    {
      buildSettings: {
        CONFIGURATION: "Debug",
        PLATFORM_NAME: "iphonesimulator",
        IS_UNOPTIMIZED_BUILD: "NO",
        TARGET_BUILD_DIR: ".build/products",
        WRAPPER_NAME: "Companion.app",
      },
    },
  ]);

  assert.deepEqual(parseAppPaths(xcodeOutput, "Debug", "/tmp/project", { kind: "simulator" }), [
    path.resolve("/tmp/project/.build/products/App.app"),
    path.resolve("/tmp/project/.build/products/Companion.app"),
  ]);
});

void test("requires exact Debug and Release configuration names", () => {
  for (const expected of ["Debug", "Release"] as const) {
    for (const actual of [
      "Debug",
      "Release",
      "debug",
      "release",
      "DEBUG",
      "RELEASE",
      "DebugStaging",
    ]) {
      const xcodeOutput = JSON.stringify([
        {
          buildSettings: {
            CONFIGURATION: actual,
            PLATFORM_NAME: "iphonesimulator",
            TARGET_BUILD_DIR: "/tmp/build",
            WRAPPER_NAME: "App.app",
          },
        },
      ]);
      const parse = () => parseAppPaths(xcodeOutput, expected, "/tmp", { kind: "simulator" });
      if (actual === expected) {
        assert.deepEqual(parse(), ["/tmp/build/App.app"]);
      } else {
        assert.throws(
          parse,
          (error) =>
            error instanceof CompileError &&
            error.message.includes(`requires "${expected}", but Xcode used "${actual}"`),
        );
      }
    }
  }
});

void test("reports a missing CocoaPods workspace or Pods directory", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-pods-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  await mkdir(path.join(projectDirectory, "App.xcodeproj"));
  await writeFile(path.join(projectDirectory, "Podfile"), "platform :ios, '16.0'\n");

  await assert.rejects(
    resolveIosSource(projectDirectory),
    (error) => error instanceof CompileError && /no \.xcworkspace/.test(error.message),
  );
  await mkdir(path.join(projectDirectory, "App.xcworkspace"));
  await assert.rejects(
    resolveIosSource(projectDirectory),
    (error) => error instanceof CompileError && /Pods directory is missing/.test(error.message),
  );
});

void test("builds the UIKit project and copies its app", { skip: !isMacOS }, async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-project-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  await copyFixture(fixtureProjectPath, path.join(projectDirectory, "CompilePrototype.xcodeproj"));
  await copyFixture(
    path.join(fixtureDirectory, "CompilePrototype"),
    path.join(projectDirectory, "CompilePrototype"),
  );
  const outputDir = path.join(projectDirectory, "output");
  const processResult = await runCli(["ios", "--dev", "--output-dir", outputDir], projectDirectory);

  assert.equal(processResult.status, "exited");
  assert.equal(processResult.exitCode, 0, processResult.stderr);
  assert.equal(processResult.stderr, "");
  const appPath = path.join(outputDir, "CompilePrototype.app");
  assert.equal(processResult.stdout, `${appPath}\n`);
  await access(appPath);
});

void test("builds the UIKit workspace in production mode", { skip: !isMacOS }, async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-workspace-"));
  context.after(() => rm(projectDirectory, { force: true, recursive: true }));
  await copyFixture(fixtureDirectory, projectDirectory);
  const xcodeSource = await resolveIosSource(projectDirectory);
  assert.deepEqual(xcodeSource, {
    kind: "workspace",
    path: path.join(projectDirectory, "CompilePrototype.xcworkspace"),
  });
  const processResult = await runCli(["ios", "--prod"], projectDirectory);

  assert.equal(processResult.status, "exited");
  assert.equal(processResult.exitCode, 0, processResult.stderr);
  assert.equal(processResult.stderr, "");
  const outputMatch = /^(.+\.app)\n$/.exec(processResult.stdout);
  assert.ok(outputMatch);
  const appPath = outputMatch[1];
  assert.ok(appPath);
  assert.ok(path.isAbsolute(appPath), appPath);
  assert.match(appPath, /Release-iphonesimulator/);
  await access(appPath);
});

for (const [name, kind] of [
  ["App.xcodeproj", "project"],
  ["App.xcworkspace", "workspace"],
] as const) {
  void test(`finds a symlinked Xcode ${kind}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-ios-source-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const nativeSource = path.join(root, "native", name);
    const project = path.join(root, "project");
    const linkedSource = path.join(project, name);
    await mkdir(nativeSource, { recursive: true });
    await mkdir(project);
    await symlink(nativeSource, linkedSource, isWindows ? "junction" : "dir");

    assert.deepEqual(await resolveIosSource(project), { kind, path: linkedSource });
  });
}

void test("accepts installed Pods through a directory symlink", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compile-ios-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pods = path.join(root, "native", "Pods");
  const project = path.join(root, "project");
  const workspace = path.join(project, "App.xcworkspace");
  await mkdir(pods, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(project, "Podfile"), "platform :ios, '16.0'\n");
  await symlink(pods, path.join(project, "Pods"), isWindows ? "junction" : "dir");

  assert.deepEqual(await resolveIosSource(project), { kind: "workspace", path: workspace });
});

void test("rejects malformed Xcode settings and configurations that disagree with the selected mode", () => {
  for (const [input, message] of [
    ["", /invalid JSON/],
    ["{", /invalid JSON/],
    ["null", /invalid build settings data/],
    ["{}", /invalid build settings data/],
    ["[]", /no \.app product/],
    ["[{}]", /no \.app product/],
    ['[{"buildSettings":{"WRAPPER_NAME":"../App.app"}}]', /invalid WRAPPER_NAME data/],
    [
      '[{"buildSettings":{"CONFIGURATION":"Debug","WRAPPER_NAME":"App.app"}}]',
      /invalid PLATFORM_NAME data/,
    ],
    [
      '[{"buildSettings":{"PLATFORM_NAME":"iphonesimulator","WRAPPER_NAME":"App.app"}}]',
      /invalid CONFIGURATION data/,
    ],
    [
      '[{"buildSettings":{"PLATFORM_NAME":"iphonesimulator","CONFIGURATION":"Debug","WRAPPER_NAME":"App.app"}}]',
      /invalid TARGET_BUILD_DIR data/,
    ],
    [
      '[{"buildSettings":{"PLATFORM_NAME":"iphonesimulator","CONFIGURATION":"Release","WRAPPER_NAME":"App.app","TARGET_BUILD_DIR":"/tmp"}}]',
      /requires "Debug", but Xcode used "Release"/,
    ],
  ] as const) {
    assert.throws(
      () => parseAppPaths(input, "Debug", os.tmpdir(), { kind: "simulator" }),
      (error) => error instanceof CompileError && message.test(error.message),
      input,
    );
  }
});

void test(
  "ignores an unrelated symlink loop when finding an Xcode project",
  { skip: isWindows },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-unrelated-link-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, "App.xcodeproj");
    await mkdir(project);
    await symlink("unrelated-notes", path.join(root, "unrelated-notes"));

    assert.deepEqual(await resolveIosSource(root), { kind: "project", path: project });
  },
);

function runCli(args: readonly string[], cwd = packageRoot) {
  return runProcess(process.execPath, [cliPath, ...args], createCaptureOptions(cwd));
}

function createCaptureOptions(cwd: string): RunProcessOptions {
  return {
    cwd,
    env: undefined,
    outputMode: "capture",
    signal: undefined,
  };
}
