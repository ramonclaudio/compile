import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createGradleCommand } from "../src/android.ts";
import { runProcess } from "../src/process.ts";
import { copyFixture } from "./fixtures.ts";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixture = path.join(packageRoot, "fixtures", "android-java");
const cli = path.join(packageRoot, "dist", "cli.js");
const hasAndroidSdk =
  process.env.ANDROID_HOME !== undefined || process.env.ANDROID_SDK_ROOT !== undefined;

void test(
  "keeps inferred Android builds usable after a configure-on-demand invocation",
  { skip: !hasAndroidSdk },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-gradle-options-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    await copyFixture(fixture, project);
    await appendFile(
      path.join(project, "gradle.properties"),
      [
        "",
        "org.gradle.configureondemand=true",
        "org.gradle.workers.max=2",
        "org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m",
        "",
      ].join("\n"),
    );

    const reportPath = path.join(root, "artifacts.json");
    const rejected = await runInferredReportWithConfigureOnDemand(project, reportPath);
    assert.equal(rejected.status, "exited");
    assert.equal(rejected.exitCode, 1, rejected.stderr);
    assert.match(rejected.stderr, /Compile requires --no-configure-on-demand/);
    await assert.rejects(readFile(reportPath), { code: "ENOENT" });

    const first = await compileApks(project, path.join(root, "first"));
    assert.doesNotMatch(first.output, /Configuration cache entry reused/);
    const source = path.join(
      project,
      "app",
      "src",
      "main",
      "java",
      "dev",
      "compile",
      "fixture",
      "MainActivity.java",
    );
    await writeFile(
      source,
      [
        "package dev.compile.fixture;",
        "import android.app.Activity;",
        "public final class MainActivity extends Activity {",
        '  public static String changedSource() { return "compile changed source"; }',
        "}",
        "",
      ].join("\n"),
    );

    const second = await compileApks(project, path.join(root, "second"));
    assert.match(second.output, /Configuration cache entry reused/);
    assert.equal(second.hashes.length, first.hashes.length);
    for (const [index, hash] of second.hashes.entries()) {
      assert.notEqual(
        hash,
        first.hashes[index],
        "Compile returned an APK from before the Java source changed.",
      );
    }

    const warm = await runInferredReportWithConfigureOnDemand(project, reportPath);
    assert.equal(warm.status, "exited");
    assert.equal(warm.exitCode, 0, warm.stderr);
    assert.match(warm.stdout + warm.stderr, /Configuration cache entry reused/);
    const report: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    assert.ok(typeof report === "object" && report !== null && "paths" in report);
    assert.ok(Array.isArray(report.paths));
    assert.equal(report.paths.length, 3);
    const warmHashes = await Promise.all(
      report.paths.map(async (artifact: unknown) => {
        assert.ok(typeof artifact === "string");
        return createHash("sha256")
          .update(await readFile(artifact))
          .digest("hex");
      }),
    );
    assert.deepEqual(warmHashes.sort(), [...second.hashes].sort());

    await writeFile(
      source,
      (await readFile(source, "utf8")).replace(
        "compile changed source",
        "compile changed source again",
      ),
    );
    const final = await compileApks(project, path.join(root, "final"));
    assert.match(final.output, /Configuration cache entry reused/);
    for (const [index, hash] of final.hashes.entries()) {
      assert.notEqual(
        hash,
        second.hashes[index],
        "The warm configure-on-demand invocation left a stale task graph.",
      );
    }
  },
);

void test(
  "lists root-project variants without an extra colon",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-root-variants-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    const plugins = await readFile(path.join(project, "build.gradle"), "utf8");
    const app = await readFile(path.join(project, "app", "build.gradle"), "utf8");
    const settings = await readFile(path.join(project, "settings.gradle"), "utf8");
    await writeFile(
      path.join(project, "build.gradle"),
      [
        plugins.replace(" apply false", ""),
        app.replace(/^plugins \{[^}]*\}\s*/, ""),
        `android {
  flavorDimensions "tier"
  productFlavors {
    free { dimension "tier" }
    paid { dimension "tier" }
  }
}`,
      ].join("\n"),
    );
    await writeFile(path.join(project, "settings.gradle"), settings.replace('include ":app"', ""));
    await rename(path.join(project, "app", "src"), path.join(project, "src"));
    await rm(path.join(project, "app"), { recursive: true });

    const result = await runProcess(process.execPath, [cli, "android", "--dev"], {
      cwd: project,
      env: undefined,
      outputMode: "capture",
      signal: undefined,
    });
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Compile found no Android application variant named debug/);
    assert.match(result.stderr, /:freeDebug\b/);
    assert.match(result.stderr, /:paidDebug\b/);
    assert.doesNotMatch(result.stderr, /::(?:free|paid)/);
  },
);

void test(
  "reports missing APK metadata after packaging",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-apk-metadata-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await compileApks(project, path.join(project, "copied"));
    await rm(path.join(project, "app", "build", "outputs", "apk", "debug", "output-metadata.json"));
    const reportPath = path.join(project, "missing-metadata-report.json");
    const command = createGradleCommand(
      path.join(project, process.platform === "win32" ? "gradlew.bat" : "gradlew"),
      [
        "compileAndroidDevelopmentApk",
        "--console=plain",
        "--no-configure-on-demand",
        "--exclude-task",
        ":app:packageDebug",
        "--init-script",
        path.join(packageRoot, "gradle", "android.gradle"),
      ],
    );
    const result = await runProcess(command.command, command.args, {
      cwd: project,
      env: { ...process.env, COMPILE_ANDROID_REPORT: reportPath },
      outputMode: "capture",
      signal: undefined,
    });
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /Compile found no APK metadata in /);
    assert.match(result.stderr, /outputs[/\\]apk[/\\]debug/);
    await assert.rejects(readFile(reportPath), { code: "ENOENT" });
  },
);

async function runInferredReportWithConfigureOnDemand(cwd: string, reportPath: string) {
  const command = createGradleCommand(
    path.join(cwd, process.platform === "win32" ? "gradlew.bat" : "gradlew"),
    [
      "compileAndroidDevelopmentApk",
      "--console=plain",
      "--configure-on-demand",
      "--init-script",
      path.join(packageRoot, "gradle", "android.gradle"),
    ],
  );
  return runProcess(command.command, command.args, {
    cwd,
    env: {
      ...process.env,
      COMPILE_ANDROID_REPORT: reportPath,
    },
    outputMode: "capture",
    signal: undefined,
  });
}

async function compileApks(
  cwd: string,
  outputDir: string,
): Promise<{ readonly hashes: readonly string[]; readonly output: string }> {
  const result = await runProcess(
    process.execPath,
    [cli, "android", "--dev", "--output-dir", outputDir],
    {
      cwd,
      env: undefined,
      outputMode: "capture",
      signal: undefined,
    },
  );
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  const hashes: string[] = [];
  for (const line of lines) {
    assert.ok(line.startsWith("Output: "), line);
    const artifact = line.slice("Output: ".length);
    assert.equal(path.dirname(artifact), outputDir);
    assert.equal(path.extname(artifact), ".apk");
    const bytes = await readFile(artifact);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, "APK is missing its ZIP header.");
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  return { hashes, output: result.stdout + result.stderr };
}
