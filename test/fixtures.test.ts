import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { copyFixture } from "./fixtures.ts";

void test("copies native source and wrapper files without generated output", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-fixture-copy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  const sourceFiles = [
    "gradlew",
    "gradlew.bat",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
    "app/src/main/Main.java",
    "ios/App.swift",
    "App.xcodeproj/project.pbxproj",
    "App.xcworkspace/contents.xcworkspacedata",
  ];
  const generatedFiles = [
    "build/intermediates/output",
    "app/build/outputs/app.apk",
    ".build/cache",
    ".gradle/cache",
    "out/old-output",
    "node_modules/package/index.js",
    "App.xcodeproj/xcuserdata/user.xcuserstate",
    "DerivedData/cache",
    "App.app/Info.plist",
    "App.ipa",
    "app.apk",
    "app.aab",
    "App.xcarchive/Info.plist",
    "App.xcresult/result",
    "App.dSYM/symbols",
  ];
  for (const name of [...sourceFiles, ...generatedFiles]) {
    const file = path.join(source, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name);
  }
  await chmod(path.join(source, "gradlew"), 0o755);

  await copyFixture(source, destination);

  const copiedFiles = [];
  for (const entry of await readdir(destination, { recursive: true })) {
    if ((await stat(path.join(destination, entry))).isFile()) {
      copiedFiles.push(entry.split(path.sep).join("/"));
    }
  }
  assert.deepEqual(copiedFiles.sort(), [...sourceFiles].sort());
  for (const name of sourceFiles) {
    assert.equal(await readFile(path.join(destination, name), "utf8"), name);
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(destination, "gradlew"))).mode & 0o777, 0o755);
  }
  assert.equal(await readFile(path.join(source, "App.ipa"), "utf8"), "App.ipa");
});
