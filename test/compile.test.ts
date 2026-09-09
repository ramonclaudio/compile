import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileAndroid, resolveGradleWrapper } from "../src/android.ts";
import { compileIos, resolveIosSource } from "../src/ios.ts";
import { copyFixture } from "./fixtures.ts";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const hasAndroidSdk =
  process.env.ANDROID_HOME !== undefined || process.env.ANDROID_SDK_ROOT !== undefined;

void test("discovery returns absolute native paths for a relative project directory", async (context) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "compile-relative-discovery-"));
  context.after(() => rm(project, { recursive: true, force: true }));
  const workspace = path.join(project, "ios", "App.xcworkspace");
  const android = path.join(project, "android");
  const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  await mkdir(workspace, { recursive: true });
  await mkdir(android);
  await writeFile(path.join(android, wrapperName), "wrapper fixture");
  const relativeProject = path.relative(process.cwd(), project);

  assert.deepEqual(await resolveIosSource(relativeProject), { kind: "workspace", path: workspace });
  assert.deepEqual(await resolveGradleWrapper(relativeProject), {
    cwd: android,
    path: path.join(android, wrapperName),
  });
});

for (const platform of ["ios", "android"] as const) {
  for (const projectPath of ["relative", "absolute"] as const) {
    void test(
      `${platform} API resolves ${projectPath} project paths and a relative output directory`,
      {
        skip: platform === "ios" ? process.platform !== "darwin" : !hasAndroidSdk,
      },
      async (context) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "compile-api-"));
        context.after(() => rm(directory, { recursive: true, force: true }));
        const project = path.join(directory, "project with spaces");
        const outputDirectory = `copied outputs ${path.basename(directory)}`;
        await copyFixture(
          path.join(fixtures, platform === "ios" ? "ios-uikit" : "android-java"),
          project,
        );
        const options = {
          cwd: projectPath === "relative" ? path.relative(process.cwd(), project) : project,
          mode: "development",
          outputDir: path.join("..", outputDirectory),
        } as const;
        const outputs =
          platform === "ios"
            ? await compileIos(
                Object.freeze({
                  ...options,
                  platform,
                  outputType: "app",
                  destination: { kind: "simulator" },
                } as const),
              )
            : await compileAndroid(
                Object.freeze({ ...options, platform, outputType: "apk" } as const),
              );

        assert.equal(outputs.length, platform === "ios" ? 1 : 3);
        for (const output of outputs) {
          assert.equal(path.dirname(output), path.join(directory, outputDirectory));
          if (platform === "ios") {
            assert.equal(path.extname(output), ".app");
            assert.ok((await stat(output)).isDirectory());
          } else {
            assert.equal(path.extname(output), ".apk");
            assert.equal((await readFile(output)).readUInt32LE(0), 0x04034b50);
          }
        }
      },
    );
  }
}
