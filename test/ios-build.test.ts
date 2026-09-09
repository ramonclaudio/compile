import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildIos } from "../src/ios.ts";
import type { IosBuildRequest } from "../src/ios.ts";
import { runProcess } from "../src/process.ts";
import type { ProcessRunner, RunProcessOptions } from "../src/process.ts";
import { CompileError } from "../src/types.ts";
import type { IosBuildPlatform } from "../src/types.ts";
import { copyFixture } from "./fixtures.ts";

void test("resolved Xcode builds preserve selected inputs, environment, cancellation, and all app paths", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-resolved-ios-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const controller = new AbortController();
  const env = { NODE_ENV: "caller-mode", SKIP_BUNDLING: "1", RCT_METRO_PORT: "8083" };
  const request: IosBuildRequest = {
    cwd,
    source: { kind: "workspace", path: "native/Selected.xcworkspace" },
    scheme: "SelectedApp",
    configuration: "Release-Staging",
    destination: "id=selected-simulator",
    platform: "iphonesimulator",
    buildArgs: ["-derivedDataPath", "clean", "DEVELOPMENT_TEAM=TEAM", "-allowProvisioningUpdates"],
    clean: true,
  };
  const appPaths = [
    path.join(cwd, "products", "App.app"),
    path.join(cwd, "companion", "App.app"),
  ].sort();
  const calls: { command: string; args: readonly string[]; options: RunProcessOptions }[] = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/plutil") return succeeded("App\n");
    assert.equal(command, "/usr/bin/xcrun");
    if (options.outputMode === "capture") {
      return succeeded(
        JSON.stringify([
          ...appPaths.map((appPath) => settings(appPath, request.platform, request.configuration)),
          settings(path.join(cwd, "Watch.app"), "watchsimulator", "Debug"),
        ]),
      );
    }
    for (const appPath of appPaths) await writeApp(appPath);
    return succeeded("");
  };

  assert.deepEqual(
    await buildIos(request, { env, signal: controller.signal, runProcess: runner }),
    appPaths,
  );
  const selectors = [
    "xcodebuild",
    "-workspace",
    path.join(cwd, "native/Selected.xcworkspace"),
    "-scheme",
    "SelectedApp",
    "-configuration",
    "Release-Staging",
    "-destination",
    "id=selected-simulator",
    ...(request.buildArgs ?? []),
  ];
  assert.deepEqual(calls[0]?.args, [...selectors, "-showBuildSettings", "-json"]);
  assert.deepEqual(calls[1]?.args, [...selectors, "clean", "build"]);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.cwd, cwd);
    assert.equal(call.options.env, env);
    assert.equal(call.options.signal, controller.signal);
  }
  assert.equal(env.NODE_ENV, "caller-mode");
});

void test("resolved Xcode builds select products for each supported Apple platform", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-apple-platforms-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const platforms: readonly IosBuildPlatform[] = [
    "iphoneos",
    "iphonesimulator",
    "appletvos",
    "appletvsimulator",
    "watchos",
    "watchsimulator",
    "xros",
    "xrsimulator",
  ];
  for (const platform of platforms) {
    const appPath = path.join(cwd, platform, "App.app");
    const embeddedPlatform =
      platform === "watchos" || platform === "watchsimulator" ? "iphoneos" : "watchos";
    const runner: ProcessRunner = async (command, _args, options) => {
      if (command === "/usr/bin/plutil") return succeeded("App\n");
      if (options.outputMode === "capture") {
        return succeeded(
          JSON.stringify([
            settings(appPath, platform, "Debug-Custom"),
            settings(path.join(cwd, "Embedded.app"), embeddedPlatform, "Release"),
          ]),
        );
      }
      await writeApp(appPath);
      return succeeded("");
    };

    assert.deepEqual(
      await buildIos(
        {
          cwd,
          source: { kind: "project", path: "App.xcodeproj" },
          scheme: "App",
          configuration: "Debug-Custom",
          destination: "id=selected-device",
          platform,
        },
        { runProcess: runner },
      ),
      [appPath],
    );
  }
});

void test("resolved Xcode builds reject a different configuration or device platform before building", async () => {
  const request: IosBuildRequest = {
    cwd: os.tmpdir(),
    source: { kind: "project", path: "App.xcodeproj" },
    scheme: "App",
    configuration: "Release-Staging",
    destination: "generic/platform=iOS",
    platform: "iphoneos",
  };
  for (const [platform, configuration, message] of [
    ["iphoneos", "Debug", /requires "Release-Staging"/],
    [
      "iphonesimulator",
      "Release-Staging",
      /requested iphoneos, but Xcode selected iphonesimulator/,
    ],
    ["appletvos", "Release-Staging", /no \.app product/],
  ] as const) {
    let calls = 0;
    const runner: ProcessRunner = async (_command, _args, options) => {
      calls += 1;
      assert.equal(options.outputMode, "capture");
      return succeeded(JSON.stringify([settings("/tmp/App.app", platform, configuration)]));
    };
    await assert.rejects(buildIos(request, { runProcess: runner }), message);
    assert.equal(calls, 1);
  }
});

void test("resolved Xcode builds propagate native failures and cancellation without returning stale apps", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-ios-native-failure-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const appPath = path.join(cwd, "App.app");
  await writeApp(appPath);
  const request: IosBuildRequest = {
    cwd,
    source: { kind: "project", path: "App.xcodeproj" },
    scheme: "App",
    configuration: "Debug",
    destination: "generic/platform=iOS Simulator",
    platform: "iphonesimulator",
  };
  for (const failure of [
    { status: "exited", exitCode: 65, stdout: "", stderr: "native failure" },
    { status: "signaled", signal: "SIGINT", stdout: "", stderr: "" },
  ] as const) {
    const runner: ProcessRunner = async (_command, _args, options) =>
      options.outputMode === "capture"
        ? succeeded(JSON.stringify([settings(appPath, "iphonesimulator", "Debug")]))
        : failure;
    await assert.rejects(buildIos(request, { runProcess: runner }), (error) => {
      assert.ok(error instanceof CompileError);
      if (failure.status === "exited") {
        assert.equal(error.exitCode, 65);
        assert.match(error.message, /native failure/);
      } else {
        assert.equal(error.signal, "SIGINT");
      }
      return true;
    });
  }
  assert.equal(await readFile(path.join(appPath, "App"), "utf8"), "native executable");
});

void test(
  "builds a selected custom Xcode configuration through the resolved API",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "compile selected configuration "));
    context.after(() => rm(cwd, { force: true, recursive: true }));
    const fixture = fileURLToPath(new URL("../fixtures/ios-uikit", import.meta.url));
    const project = path.join(cwd, "CompilePrototype.xcodeproj");
    await copyFixture(fixture, cwd);
    const projectFile = path.join(project, "project.pbxproj");
    const configuration = "Release-Staging QA";
    await writeFile(
      projectFile,
      (await readFile(projectFile, "utf8")).replaceAll(
        "name = Release;",
        `name = "${configuration}";`,
      ),
    );

    const output = await buildIos(
      {
        cwd,
        source: { kind: "project", path: project },
        scheme: "CompilePrototype",
        configuration,
        destination: "generic/platform=iOS Simulator",
        platform: "iphonesimulator",
        buildArgs: ["-derivedDataPath", path.join(cwd, "derived data")],
        clean: true,
        outputDir: "copied apps",
      },
      {
        runProcess: (command, args, options) =>
          runProcess(command, args, { ...options, outputMode: "capture" }),
      },
    );

    const appPath = path.join(cwd, "copied apps", "CompilePrototype.app");
    assert.deepEqual(output, [appPath]);
    assert.ok((await stat(path.join(appPath, "CompilePrototype"))).size > 0);
    assert.ok(
      (
        await stat(
          path.join(
            cwd,
            `derived data/Build/Products/${configuration}-iphonesimulator/CompilePrototype.app`,
          ),
        )
      ).isDirectory(),
    );
  },
);

function settings(appPath: string, platform: IosBuildPlatform, configuration: string) {
  return {
    buildSettings: {
      WRAPPER_NAME: path.basename(appPath),
      TARGET_BUILD_DIR: path.dirname(appPath),
      PLATFORM_NAME: platform,
      CONFIGURATION: configuration,
    },
  };
}

async function writeApp(appPath: string): Promise<void> {
  await mkdir(appPath, { recursive: true });
  await writeFile(path.join(appPath, "App"), "native executable", { mode: 0o755 });
}

function succeeded(stdout: string) {
  return { status: "exited", exitCode: 0, stdout, stderr: "" } as const;
}
