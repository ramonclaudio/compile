import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "../src/args.ts";
import { findIpas, validateExportOptions } from "../src/ios-export.ts";
import { parseAppPaths } from "../src/ios.ts";
import { runProcess } from "../src/process.ts";
import { CompileError } from "../src/types.ts";
import { copyFixture } from "./fixtures.ts";

const fixture = fileURLToPath(new URL("../fixtures/ios-uikit", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const macOnly = { skip: process.platform !== "darwin" };

void test("IPA uses the existing output flag and requires a device destination", () => {
  const result = parseCliArgs(["ios", "--prod", "--device", "--output-type", "ipa"], os.tmpdir());
  assert.equal(result.kind, "compile");
  assert.equal(result.request.platform, "ios");
  assert.equal(result.request.outputType, "ipa");
  assert.throws(
    () => parseCliArgs(["ios", "--dev", "--output-type", "ipa"], os.tmpdir()),
    /requires --device/,
  );
});

void test("export options require an explicit local iOS distribution method", () => {
  for (const method of [
    "debugging",
    "release-testing",
    "enterprise",
    "app-store-connect",
    "development",
    "ad-hoc",
    "app-store",
  ]) {
    validateExportOptions({ method });
    validateExportOptions({ method, destination: "export", signingStyle: "manual" });
    assert.throws(
      () => validateExportOptions({ method, destination: "upload" }),
      (error) => error instanceof CompileError && /exports local IPA/.test(error.message),
    );
  }
  for (const [invalid, message] of [
    [null, /must contain a dictionary/],
    [[], /must contain a dictionary/],
    ["debugging", /must contain a dictionary/],
    [{}, /distribution method/],
    [{ method: 1 }, /distribution method/],
    [{ method: "validation" }, /distribution method/],
    [{ method: "developer-id" }, /distribution method/],
    [{ method: "debugging", destination: false }, /exports local IPA/],
  ] as const) {
    assert.throws(
      () => validateExportOptions(invalid),
      (error) => error instanceof CompileError && message.test(error.message),
    );
  }
  assert.throws(
    () => validateExportOptions({}),
    /Legacy aliases development, ad-hoc, and app-store are also accepted/,
  );
});

void test("finds sorted nested IPAs and ignores export sidecars", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-files-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(path.join(directory, "Apps"));
  await mkdir(path.join(directory, "container.ipa"));
  for (const file of [
    "Z.ipa",
    "Apps/A.ipa",
    "container.ipa/B.ipa",
    "DistributionSummary.plist",
    "Apps/notes.txt",
  ]) {
    await writeFile(path.join(directory, file), "exported file");
  }

  assert.deepEqual(await findIpas(directory), [
    path.join(directory, "Apps", "A.ipa"),
    path.join(directory, "container.ipa", "B.ipa"),
    path.join(directory, "Z.ipa"),
  ]);
});

void test("returns no IPAs for an empty export directory", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-empty-"));
  context.after(() => rm(directory, { force: true, recursive: true }));

  assert.deepEqual(await findIpas(directory), []);
});

void test("rejects an empty IPA alongside nonempty IPAs", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-invalid-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(path.join(directory, "App.ipa"), "exported file");
  const emptyIpa = path.join(directory, "Empty.ipa");
  await writeFile(emptyIpa, "");

  await assert.rejects(
    findIpas(directory),
    (error) =>
      error instanceof CompileError &&
      error.message === `Xcode exported an empty IPA file: ${emptyIpa}.`,
  );
});

void test(
  "ignores IPA symlinks and directory cycles",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-links-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    const exportDirectory = path.join(directory, "export");
    const outsideDirectory = path.join(directory, "outside");
    await mkdir(exportDirectory);
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "App.ipa"), "outside file");
    await symlink(path.join(outsideDirectory, "App.ipa"), path.join(exportDirectory, "Linked.ipa"));
    await symlink(outsideDirectory, path.join(exportDirectory, "linked-directory"));
    await symlink(exportDirectory, path.join(exportDirectory, "cycle"));
    await symlink(path.join(directory, "missing"), path.join(exportDirectory, "Missing.ipa"));

    assert.deepEqual(await findIpas(exportDirectory), []);
  },
);

void test("preserves errors when the export directory cannot be read", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-read-error-"));
  context.after(() => rm(directory, { force: true, recursive: true }));

  await assert.rejects(findIpas(path.join(directory, "missing")), { code: "ENOENT" });
});

void test("iOS products can share a scheme with app targets for other platforms", () => {
  const entries = ["watchsimulator", "macosx", "iphonesimulator"].map((platform) => ({
    buildSettings: {
      PLATFORM_NAME: platform,
      CONFIGURATION: "Debug",
      TARGET_BUILD_DIR: `/tmp/${platform}`,
      WRAPPER_NAME: `${platform}.app`,
    },
  }));
  assert.deepEqual(parseAppPaths(JSON.stringify(entries), "Debug", "/tmp", { kind: "simulator" }), [
    "/tmp/iphonesimulator/iphonesimulator.app",
  ]);
  assert.throws(
    () =>
      parseAppPaths(JSON.stringify(entries.slice(0, 2)), "Debug", "/tmp", {
        kind: "device",
        id: "some-mac",
      }),
    /no \.app product/,
  );
});

void test(
  "does not copy an app when Xcode succeeds without an executable",
  macOnly,
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-empty-arch-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await copyFixture(fixture, directory);
    const project = path.join(directory, "CompilePrototype.xcodeproj/project.pbxproj");
    await writeFile(
      project,
      (await readFile(project, "utf8")).replaceAll(
        "CODE_SIGNING_ALLOWED = NO;",
        'CODE_SIGNING_ALLOWED = NO;\n EXCLUDED_ARCHS = "arm64 x86_64";',
      ),
    );
    const output = path.join(directory, "output");
    await mkdir(output);
    await writeFile(path.join(output, "marker"), "keep");
    const result = await runCli(directory, ["ios", "--dev", "--output-dir", output]);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /without a usable executable/);
    assert.deepEqual(await readdir(output), ["marker"]);
  },
);

void test(
  "builds the iOS and watchOS targets and returns the iOS app",
  macOnly,
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-watch-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await copyFixture(fileURLToPath(new URL("../fixtures/ios-watch", import.meta.url)), directory);
    const result = await runCli(directory, ["ios", "--dev", "--output-dir", "output"]);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      `${path.join(await realpath(directory), "output", "CompilePrototype.app")}\n`,
    );
    assert.ok(
      (await readdir(path.join(directory, "build", "Debug-watchsimulator"))).includes("Watch.app"),
    );
    assert.deepEqual(await readdir(path.join(directory, "output")), ["CompilePrototype.app"]);
  },
);

void test(
  "rejects missing, invalid, or upload export options before archiving",
  macOnly,
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-export-options-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await copyFixture(fixture, directory);
    const optionsPath = path.join(directory, "ExportOptions.plist");
    for (const [contents, message] of [
      [undefined, /IPA export requires Apple's ExportOptions\.plist/],
      ["invalid plist", /Export options validation .* failed/],
      [
        '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>debugging</string><key>destination</key><string>upload</string></dict></plist>',
        /Compile exports local IPA files/,
      ],
    ] as const) {
      if (contents !== undefined) await writeFile(optionsPath, contents);
      const result = await runCli(directory, [
        "ios",
        "--prod",
        "--device",
        "--output-type",
        "ipa",
        "--output-dir",
        "output",
      ]);
      assert.equal(result.status, "exited");
      assert.notEqual(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /ARCHIVE SUCCEEDED|ARCHIVE FAILED|EXPORT SUCCEEDED/);
      assert.ok(!(await readdir(directory)).includes("output"));
    }
  },
);

void test(
  "rejects a simulator ID before the archive action can switch to a device",
  macOnly,
  async (context) => {
    const simulatorId = await getIosSimulatorId();
    if (simulatorId === undefined) {
      context.skip("No available iOS simulator destination.");
      return;
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-ipa-simulator-"));
    context.after(() => rm(directory, { force: true, recursive: true }));
    await copyFixture(fixture, directory);
    await writeFile(
      path.join(directory, "ExportOptions.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>debugging</string></dict></plist>',
    );
    const result = await runCli(directory, [
      "ios",
      "--dev",
      "--device",
      simulatorId,
      "--output-type",
      "ipa",
      "--output-dir",
      "output",
    ]);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /requested iphoneos.*iphonesimulator/);
    assert.doesNotMatch(result.stderr, /ARCHIVE SUCCEEDED|ARCHIVE FAILED/);
    assert.ok(!(await readdir(directory)).includes("output"));
  },
);

async function getIosSimulatorId(): Promise<string | undefined> {
  const devices = await runProcess(
    "/usr/bin/xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    {
      cwd: os.tmpdir(),
      env: undefined,
      outputMode: "capture",
      signal: undefined,
    },
  );
  assert.equal(devices.status, "exited");
  assert.equal(devices.exitCode, 0, devices.stderr);
  const data: unknown = JSON.parse(devices.stdout);
  assert.ok(typeof data === "object" && data !== null && "devices" in data);
  assert.ok(typeof data.devices === "object" && data.devices !== null);
  const available: unknown = Object.entries(data.devices).find(
    ([runtime, entries]) =>
      runtime.includes(".iOS-") && Array.isArray(entries) && entries.length > 0,
  )?.[1];
  if (available === undefined) return undefined;
  assert.ok(Array.isArray(available));
  const first: unknown = available[0];
  assert.ok(
    typeof first === "object" &&
      first !== null &&
      "udid" in first &&
      typeof first.udid === "string",
  );
  return first.udid;
}

function runCli(cwd: string, args: readonly string[]) {
  return runProcess(process.execPath, [cli, ...args], {
    cwd,
    env: undefined,
    outputMode: "capture",
    signal: undefined,
  });
}
