import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { compileIos } from "../src/ios.ts";
import type { ProcessRunner, RunProcessOptions } from "../src/process.ts";
import { CompileError } from "../src/types.ts";
import type { IosCompileRequest } from "../src/types.ts";

const localExportOptions =
  '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>debugging</string><key>destination</key><string>export</string></dict></plist>';
const uploadExportOptions = localExportOptions.replace(
  "<string>export</string>",
  "<string>upload</string>",
);

void test("IPA requests exclude simulator destinations in types and at the JavaScript boundary", async () => {
  // @ts-expect-error JavaScript callers can bypass the IPA destination constraint.
  const request: IosCompileRequest = {
    platform: "ios",
    cwd: os.tmpdir(),
    mode: "development",
    outputType: "ipa",
    destination: { kind: "simulator" },
    outputDir: undefined,
  };
  await assert.rejects(
    compileIos(request, {
      runProcess: async () => assert.fail("Invalid destination must fail before native work."),
    }),
    (error) =>
      error instanceof CompileError &&
      error.exitCode === 64 &&
      /requires a device destination/.test(error.message),
  );
});

void test("rejects a missing IPA plist before invoking native tools", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-missing-ipa-options-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "App.xcodeproj"));

  await assert.rejects(
    compileIos(ipaRequest(cwd), {
      runProcess: async () => assert.fail("Missing export options must fail before native work."),
    }),
    /IPA export requires Apple's ExportOptions\.plist/,
  );
  assert.deepEqual(await readdir(cwd), ["App.xcodeproj"]);
});

void test("rejects malformed or upload IPA options before any Xcode query", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-invalid-ipa-options-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "App.xcodeproj"));
  const optionsPath = path.join(cwd, "ExportOptions.plist");
  for (const malformed of [true, false]) {
    const contents = malformed ? "not a plist" : uploadExportOptions;
    await writeFile(optionsPath, contents);
    let calls = 0;
    let validationCopy: string | undefined;
    const runner: ProcessRunner = async (command, args) => {
      calls += 1;
      assert.equal(command, "/usr/bin/plutil");
      validationCopy = args.at(-1);
      assert.ok(validationCopy);
      assert.notEqual(validationCopy, optionsPath);
      assert.equal(await readFile(validationCopy, "utf8"), contents);
      return malformed
        ? { status: "exited", exitCode: 1, stdout: "", stderr: "Invalid plist" }
        : succeeded(JSON.stringify({ method: "debugging", destination: "upload" }));
    };
    await assert.rejects(
      compileIos(ipaRequest(cwd), { runProcess: runner }),
      malformed ? /Export options validation .* failed/ : /Compile exports local IPA files/,
    );
    assert.equal(calls, 1);
    assert.ok(validationCopy);
    await assert.rejects(stat(path.dirname(validationCopy)), { code: "ENOENT" });
    assert.deepEqual(await readdir(cwd), ["App.xcodeproj", "ExportOptions.plist"]);
  }
});

void test("IPA compilation carries caller options through validation, discovery, archive, and export", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-options-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "App.xcodeproj"));
  const optionsPath = path.join(cwd, "ExportOptions.plist");
  await writeFile(optionsPath, localExportOptions);
  const env = Object.freeze({
    NODE_ENV: "caller-value",
    RCT_NO_LAUNCH_PACKAGER: "1",
    SIGNING_CONTEXT: "caller",
  });
  const signal = new AbortController().signal;
  const calls: { command: string; args: readonly string[]; options: RunProcessOptions }[] = [];
  let returnedIpa: string | undefined;
  let exportedSnapshot: string | undefined;
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/plutil") {
      const validationCopy = args.at(-1);
      assert.ok(validationCopy);
      assert.equal(await readFile(validationCopy, "utf8"), localExportOptions);
      return succeeded(JSON.stringify({ method: "debugging", destination: "export" }));
    }
    assert.equal(command, "/usr/bin/xcrun");
    if (args.includes("-list")) {
      await writeFile(optionsPath, uploadExportOptions);
      return succeeded(JSON.stringify({ project: { schemes: ["App"] } }));
    }
    if (args.includes("-showBuildSettings")) {
      return succeeded(buildSettings(path.join(cwd, "App.app"), "Release", "iphoneos"));
    }
    if (args.includes("-exportArchive")) {
      exportedSnapshot = argument(args, "-exportOptionsPlist");
      assert.notEqual(exportedSnapshot, optionsPath);
      assert.equal(await readFile(exportedSnapshot, "utf8"), localExportOptions);
      const exportPath = argument(args, "-exportPath");
      await mkdir(exportPath, { recursive: true });
      returnedIpa = path.join(exportPath, "App.ipa");
      await writeFile(returnedIpa, "exported IPA");
    } else {
      assert.ok(args.includes("archive"));
      await mkdir(argument(args, "-archivePath"));
    }
    return succeeded("");
  };

  const paths = await compileIos(ipaRequest(cwd), { env, signal, runProcess: runner });
  assert.deepEqual(paths, [returnedIpa]);
  assert.ok(paths.every((file) => path.isAbsolute(file)));
  assert.equal(await readFile(optionsPath, "utf8"), uploadExportOptions);
  assert.ok(exportedSnapshot);
  assert.equal(await readFile(exportedSnapshot, "utf8"), localExportOptions);
  assert.equal(calls.filter((call) => call.command === "/usr/bin/plutil").length, 1);
  const selectors = [
    "xcodebuild",
    "-project",
    path.join(cwd, "App.xcodeproj"),
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
  ];
  assert.deepEqual(calls[2]?.args, [...selectors, "archive", "-showBuildSettings", "-json"]);
  const archiveArgs = calls[3]?.args;
  assert.ok(archiveArgs);
  assert.deepEqual(archiveArgs, [
    ...selectors,
    "-archivePath",
    argument(archiveArgs, "-archivePath"),
    "archive",
  ]);
  assert.deepEqual(
    calls.map((call) => call.options.outputMode),
    ["capture", "capture", "capture", "stderr", "stderr"],
  );
  assert.deepEqual(calls[0]?.options.env, { ...env, NODE_ENV: "production" });
  for (const call of calls) {
    assert.equal(call.options.cwd, cwd);
    assert.equal(call.options.env, calls[0]?.options.env);
    assert.equal(call.options.signal, signal);
  }
  assert.equal(env.NODE_ENV, "caller-value");
});

void test("an explicit device ID can select an iOS simulator app without returning its watch companion", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-explicit-ios-id-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "App.xcodeproj"));
  const appPath = path.join(cwd, "App.app");
  let calls = 0;
  const runner: ProcessRunner = async (command, args) => {
    calls += 1;
    if (command === "/usr/bin/plutil") return succeeded("App\n");
    assert.equal(command, "/usr/bin/xcrun");
    if (args.includes("-list")) return succeeded(JSON.stringify({ project: { schemes: ["App"] } }));
    assert.equal(argument(args, "-destination"), "id=existing-simulator");
    if (args.includes("-showBuildSettings")) {
      return succeeded(
        JSON.stringify(
          ["iphonesimulator", "watchsimulator"].map((platform) => ({
            buildSettings: {
              PLATFORM_NAME: platform,
              CONFIGURATION: "Debug",
              TARGET_BUILD_DIR: cwd,
              WRAPPER_NAME: platform === "iphonesimulator" ? "App.app" : "Watch.app",
            },
          })),
        ),
      );
    }
    assert.equal(args.at(-1), "build");
    await mkdir(appPath);
    await writeFile(path.join(appPath, "App"), "native executable", { mode: 0o755 });
    return succeeded("");
  };

  assert.deepEqual(
    await compileIos(
      {
        platform: "ios",
        cwd,
        mode: "development",
        outputType: "app",
        destination: { kind: "device", id: "existing-simulator" },
        outputDir: undefined,
      },
      { runProcess: runner },
    ),
    [appPath],
  );
  assert.equal(calls, 4);
});

void test("app compilation carries caller options through discovery, build, inspection, and copying", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-app-options-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "App.xcodeproj"));
  const appPath = path.join(cwd, "products", "App.app");
  const signal = new AbortController().signal;
  const env = Object.freeze({ NODE_ENV: "caller-value", SKIP_BUNDLING: "1" });
  const calls: RunProcessOptions[] = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push(options);
    if (command === "/usr/bin/ditto") {
      const [source, target] = args;
      assert.ok(source && target);
      await cp(source, target, { recursive: true });
      return succeeded("");
    }
    if (command === "/usr/bin/plutil") return succeeded("App\n");
    assert.equal(command, "/usr/bin/xcrun");
    if (args.includes("-list")) return succeeded(JSON.stringify({ project: { schemes: ["App"] } }));
    if (args.includes("-showBuildSettings"))
      return succeeded(buildSettings(appPath, "Debug", "iphonesimulator"));
    assert.ok(args.includes("build"));
    await mkdir(appPath, { recursive: true });
    await writeFile(path.join(appPath, "App"), "native executable", { mode: 0o755 });
    return succeeded("");
  };

  assert.deepEqual(
    await compileIos(
      {
        platform: "ios",
        cwd,
        mode: "development",
        outputType: "app",
        destination: { kind: "simulator" },
        outputDir: "output",
      },
      { env, signal, runProcess: runner },
    ),
    [path.join(cwd, "output", "App.app")],
  );
  assert.equal(
    await readFile(path.join(cwd, "output", "App.app", "App"), "utf8"),
    "native executable",
  );
  assert.deepEqual(
    calls.map((options) => options.outputMode),
    ["capture", "capture", "stderr", "capture", "capture"],
  );
  assert.deepEqual(calls[0]?.env, {
    ...env,
    NODE_ENV: "development",
    RCT_NO_LAUNCH_PACKAGER: "true",
  });
  for (const options of calls) {
    assert.equal(options.cwd, cwd);
    assert.equal(options.env, calls[0]?.env);
    assert.equal(options.signal, signal);
  }
  assert.equal(env.NODE_ENV, "caller-value");
});

void test("IPA validation forwards a cancelled process without starting Xcode", async (context) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-cancelled-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "App.xcodeproj"));
  await writeFile(path.join(cwd, "ExportOptions.plist"), localExportOptions);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    compileIos(ipaRequest(cwd), { signal: controller.signal }),
    (error) => error instanceof CompileError && error.signal === "SIGTERM",
  );
  assert.deepEqual(await readdir(cwd), ["App.xcodeproj", "ExportOptions.plist"]);
});

for (const outputType of ["app", "ipa"] as const) {
  void test(`${outputType} compilation defaults packager suppression and preserves explicit values`, async (context) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "compile-packager-env-"));
    context.after(() => rm(cwd, { force: true, recursive: true }));
    await mkdir(path.join(cwd, "App.xcodeproj"));
    await writeFile(path.join(cwd, "ExportOptions.plist"), localExportOptions);
    const appPath = path.join(cwd, "App.app");
    const cases: readonly {
      env: NodeJS.ProcessEnv;
      expected: string | undefined;
    }[] = [
      { env: {}, expected: "true" },
      { env: { RCT_NO_LAUNCH_PACKAGER: "1" }, expected: "1" },
      { env: { RCT_NO_LAUNCH_PACKAGER: "" }, expected: "" },
      { env: { RCT_NO_LAUNCH_PACKAGER: "false" }, expected: "false" },
      { env: { RCT_NO_LAUNCH_PACKAGER: undefined }, expected: undefined },
    ];
    for (const { env, expected } of cases) {
      Object.freeze(env);
      const calls: RunProcessOptions[] = [];
      const runner: ProcessRunner = async (command, args, options) => {
        calls.push(options);
        if (command === "/usr/bin/plutil") {
          return succeeded(
            args.includes("-convert")
              ? JSON.stringify({ method: "debugging", destination: "export" })
              : "App\n",
          );
        }
        if (args.includes("-list")) {
          return succeeded(JSON.stringify({ project: { schemes: ["App"] } }));
        }
        if (args.includes("-showBuildSettings")) {
          return succeeded(buildSettings(appPath, "Release", "iphoneos"));
        }
        if (args.includes("-exportArchive")) {
          const exportPath = argument(args, "-exportPath");
          await mkdir(exportPath, { recursive: true });
          await writeFile(path.join(exportPath, "App.ipa"), "exported IPA");
        } else {
          await mkdir(appPath, { recursive: true });
          await writeFile(path.join(appPath, "App"), "native executable", { mode: 0o755 });
        }
        return succeeded("");
      };
      const paths = await compileIos(
        {
          platform: "ios",
          cwd,
          mode: "production",
          outputType,
          destination: { kind: "device" },
          outputDir: undefined,
        },
        { env, runProcess: runner },
      );
      assert.equal(paths.length, 1);
      assert.equal(calls.length, outputType === "app" ? 4 : 5);
      for (const call of calls) {
        assert.deepEqual(call.env, {
          ...env,
          NODE_ENV: "production",
          RCT_NO_LAUNCH_PACKAGER: expected,
        });
        assert.equal(call.env, calls[0]?.env);
      }
      assert.equal(Object.hasOwn(env, "NODE_ENV"), false);
    }
  });
}

function ipaRequest(cwd: string): IosCompileRequest {
  return {
    platform: "ios",
    cwd,
    mode: "production",
    outputType: "ipa",
    destination: { kind: "device" },
    outputDir: "output",
  };
}

function buildSettings(appPath: string, configuration: string, platform: string): string {
  return JSON.stringify([
    {
      buildSettings: {
        CONFIGURATION: configuration,
        PLATFORM_NAME: platform,
        TARGET_BUILD_DIR: path.dirname(appPath),
        WRAPPER_NAME: path.basename(appPath),
      },
    },
  ]);
}

function argument(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `Missing ${flag}`);
  const value = args[index + 1];
  assert.ok(value);
  return value;
}

function succeeded(stdout: string) {
  return { status: "exited", exitCode: 0, stdout, stderr: "" } as const;
}
