import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runProcess } from "../src/process.ts";
import { copyFixture } from "./fixtures.ts";

const fixture = fileURLToPath(new URL("../fixtures/ios-uikit", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

void test(
  "rejects Xcode switching a production simulator request to a device",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-platform-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await copyFixture(fixture, directory);
    const project = path.join(directory, "CompilePrototype.xcodeproj", "project.pbxproj");
    await writeFile(
      project,
      (await readFile(project, "utf8")).replace(
        /(A20000000000000000000023 \/\* Release \*\/ = \{[\s\S]*?CODE_SIGNING_ALLOWED = NO;)/,
        "$1\n\t\t\t\tSUPPORTED_PLATFORMS = iphoneos;",
      ),
    );
    const schemeDirectory = path.join(
      directory,
      "CompilePrototype.xcodeproj",
      "xcshareddata",
      "xcschemes",
    );
    await mkdir(schemeDirectory, { recursive: true });
    const reference =
      '<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A20000000000000000000010" BuildableName="CompilePrototype.app" BlueprintName="CompilePrototype" ReferencedContainer="container:CompilePrototype.xcodeproj"/>';
    await writeFile(
      path.join(schemeDirectory, "CompilePrototype.xcscheme"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.3">
<BuildAction><BuildActionEntries><BuildActionEntry buildForRunning="YES" buildForArchiving="YES">${reference}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug"><BuildableProductRunnable>${reference}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release"><BuildableProductRunnable>${reference}</BuildableProductRunnable></ProfileAction>
<ArchiveAction buildConfiguration="Release"/>
</Scheme>`,
    );
    const result = await runProcess(
      process.execPath,
      [cli, "ios", "--prod", "--output-dir", "output"],
      {
        cwd: directory,
        env: undefined,
        outputMode: "capture",
        signal: undefined,
      },
    );
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /requested iphonesimulator.*Xcode selected iphoneos/);
    assert.doesNotMatch(result.stderr, /BUILD SUCCEEDED|BUILD FAILED/);
    assert.ok(!(await readdir(directory)).includes("output"));
  },
);
