import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseCliArgs } from "../src/args.ts";
import { CompileError } from "../src/types.ts";

const cwd = path.join(os.tmpdir(), "compile-args-test");

void test("rejects conflicting development and production modes", () => {
  assert.throws(
    () => parseCliArgs(["ios", "--dev", "--prod"], cwd),
    (error) => error instanceof CompileError && error.exitCode === 64,
  );
});

void test("rejects unsupported platforms and output types", () => {
  assert.throws(() => parseCliArgs(["web", "--dev"], cwd), /Platform must be "ios" or "android"/);
  assert.throws(
    () => parseCliArgs(["ios", "--dev", "--output-type", "apk"], cwd),
    /supports output types "app" and "ipa"/,
  );
  assert.throws(
    () => parseCliArgs(["android", "--dev", "--output-type", "app"], cwd),
    /supports output types "apk" and "aab"/,
  );
});

void test("parses aliases, a device flag, and an output path", () => {
  const command = parseCliArgs(
    ["ios", "--development", "--device", "--output-dir", "output", "--output-type", "app"],
    cwd,
  );

  assert.deepEqual(command, {
    kind: "compile",
    request: {
      platform: "ios",
      outputType: "app",
      cwd,
      mode: "development",
      destination: { kind: "device" },
      outputDir: "output",
    },
  });
});

void test("rejects unsupported options", () => {
  const unsupportedOptions = [
    ["--project", "App.xcodeproj"],
    ["--workspace", "App.xcworkspace"],
    ["--scheme", "App"],
    ["--configuration", "Staging"],
    ["--variant", "release"],
    ["--target", "device"],
    ["--json"],
  ];

  for (const platform of ["ios", "android"]) {
    for (const unsupportedOption of unsupportedOptions) {
      assert.throws(
        () => parseCliArgs([platform, "--dev", ...unsupportedOption], cwd),
        /Unknown option/,
      );
    }
  }
});

void test("accepts a device ID", () => {
  const command = parseCliArgs(["ios", "--prod", "--device", "00008110-001234567890001E"], cwd);

  assert.deepEqual(command, {
    kind: "compile",
    request: {
      platform: "ios",
      outputType: "app",
      cwd,
      mode: "production",
      destination: {
        kind: "device",
        id: "00008110-001234567890001E",
      },
      outputDir: undefined,
    },
  });
});

void test("rejects an invalid device ID", () => {
  assert.throws(
    () => parseCliArgs(["ios", "--dev", "--device", "device,id"], cwd),
    /Device ID must contain only letters, numbers, and hyphens/,
  );
});

void test("parses Android APK and AAB output", () => {
  assert.deepEqual(parseCliArgs(["android", "--dev"], cwd), {
    kind: "compile",
    request: {
      platform: "android",
      cwd,
      mode: "development",
      outputType: "apk",
      outputDir: undefined,
    },
  });
  assert.deepEqual(parseCliArgs(["android", "--prod", "--output-type", "aab"], cwd), {
    kind: "compile",
    request: {
      platform: "android",
      cwd,
      mode: "production",
      outputType: "aab",
      outputDir: undefined,
    },
  });
});

void test("rejects Android device selection", () => {
  assert.throws(
    () => parseCliArgs(["android", "--dev", "--device", "emulator-5554"], cwd),
    /Android builds do not use --device/,
  );
});

void test("repeated device options use the last value", () => {
  for (const [options, destination] of [
    [["--device", "first-device", "--device"], { kind: "device" }],
    [["--device", "--device"], { kind: "device" }],
    [["--device", "--device", "last-device"], { kind: "device", id: "last-device" }],
    [["--device=first-device", "--device"], { kind: "device" }],
    [
      ["--device", "first-device", "--device", "last-device"],
      { kind: "device", id: "last-device" },
    ],
  ] as const) {
    const command = parseCliArgs(["ios", "--dev", ...options], cwd);
    assert.equal(command.kind, "compile");
    assert.equal(command.request.platform, "ios");
    assert.deepEqual(command.request.destination, destination, JSON.stringify(options));
  }
});

void test("preserves literal device arguments after the option terminator", () => {
  assert.throws(
    () => parseCliArgs(["ios", "--dev", "--", "--device"], cwd),
    (error) =>
      error instanceof CompileError &&
      error.exitCode === 64 &&
      error.message === 'Unexpected argument "--device".',
  );
});

void test("device normalization preserves strict option parsing and the input array", () => {
  const args = Object.freeze(["ios", "--dev", "--device"]);
  const command = parseCliArgs(args, cwd);
  assert.equal(command.kind, "compile");
  assert.equal(command.request.platform, "ios");
  assert.deepEqual(command.request.destination, { kind: "device" });
  assert.deepEqual(args, ["ios", "--dev", "--device"]);
  for (const option of ["--output-dir", "--output-type"]) {
    assert.throws(
      () => parseCliArgs(["ios", "--dev", option, "--device"], cwd),
      (error) =>
        error instanceof CompileError &&
        error.exitCode === 64 &&
        error.message.includes(`Option '${option}' argument is ambiguous`),
    );
  }
});

void test("preserves help precedence and validation order", () => {
  assert.deepEqual(parseCliArgs(["unknown", "--dev", "--prod", "--help"], cwd), { kind: "help" });
  for (const [args, message] of [
    [["--help", "--unknown"], /Unknown option/],
    [["unknown", "--dev", "--prod"], /Platform must be/],
    [["android", "--dev", "--prod", "--device"], /Choose exactly one mode/],
    [
      ["android", "--dev", "--device", "--output-type", "unknown"],
      /Android builds do not use --device/,
    ],
    [
      ["ios", "--dev", "--device=", "--output-type", "unknown"],
      /iOS command supports output types/,
    ],
  ] as const) {
    assert.throws(
      () => parseCliArgs(args, cwd),
      (error) =>
        error instanceof CompileError && error.exitCode === 64 && message.test(error.message),
      JSON.stringify(args),
    );
  }
});
