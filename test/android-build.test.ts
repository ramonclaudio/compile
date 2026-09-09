import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAndroid, compileAndroid, createGradleCommand } from "../src/android.ts";
import type { AndroidBuildRequest } from "../src/android.ts";
import { runProcess } from "../src/process.ts";
import type { ProcessRunner } from "../src/process.ts";
import { copyFixture } from "./fixtures.ts";

const fixture = fileURLToPath(new URL("../fixtures/android-java", import.meta.url));
const hasAndroidSdk =
  process.env.ANDROID_HOME !== undefined || process.env.ANDROID_SDK_ROOT !== undefined;

for (const mode of ["development", "production"] as const) {
  void test(`builds the ${mode} Android request with the caller's process settings`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "compile-android-inferred-call-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const wrapper = path.join(directory, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    const artifact = path.join(directory, "app.apk");
    await writeFile(wrapper, "");
    await writeFile(artifact, "artifact");
    const controller = new AbortController();
    const env = Object.freeze({ NODE_ENV: "caller-mode", CALLER_VALUE: "kept" });
    let calls = 0;
    const paths = await compileAndroid(
      {
        platform: "android",
        cwd: directory,
        mode,
        outputType: "apk",
        outputDir: "copied",
      },
      {
        env,
        signal: controller.signal,
        runProcess: async (command, args, options) => {
          calls += 1;
          assert.equal(command, wrapper);
          assert.equal(
            args[0],
            mode === "development" ? "compileAndroidDevelopmentApk" : "compileAndroidProductionApk",
          );
          assert.equal(options.cwd, directory);
          assert.equal(options.outputMode, "stderr");
          assert.equal(options.signal, controller.signal);
          assert.ok(options.env?.COMPILE_ANDROID_REPORT);
          assert.deepEqual(options.env, {
            NODE_ENV: mode,
            CALLER_VALUE: "kept",
            COMPILE_ANDROID_REPORT: options.env.COMPILE_ANDROID_REPORT,
          });
          await writeFile(
            options.env.COMPILE_ANDROID_REPORT,
            JSON.stringify({ paths: [artifact] }),
          );
          return { status: "exited", exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(paths, [path.join(directory, "copied", "app.apk")]);
    const [output] = paths;
    assert.ok(output);
    assert.equal(await readFile(output, "utf8"), "artifact");
    assert.deepEqual(env, { NODE_ENV: "caller-mode", CALLER_VALUE: "kept" });
  });
}

void test("builds the caller's Android selection with its process settings", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-android-call-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = path.join(directory, "app-free-debug.apk");
  await writeFile(artifact, "artifact");
  const controller = new AbortController();
  const env = { NODE_ENV: "test", CALLER_VALUE: "kept" };
  const gradleArgs = [
    "-x",
    "lint",
    "--configure-on-demand",
    "-PreactNativeDevServerPort=8083",
    "-PreactNativeArchitectures=arm64-v8a",
    "-Pmessage=two words",
  ];
  let calls = 0;
  const runner: ProcessRunner = async (command, args, options) => {
    calls += 1;
    assert.equal(command, path.join(directory, "custom-gradlew"));
    assert.deepEqual(args.slice(0, -2), [
      ":mobile:app:assembleFreeDebug",
      "compileAndroidApk",
      ...gradleArgs,
    ]);
    assert.equal(args.at(-2), "--init-script");
    assert.match(args.at(-1) ?? "", /gradle[/\\]android\.gradle$/);
    assert.equal(options.cwd, directory);
    assert.equal(options.env?.NODE_ENV, "test");
    assert.equal(options.env.CALLER_VALUE, "kept");
    assert.equal(options.env.COMPILE_ANDROID_MODULE, ":mobile:app");
    assert.equal(options.env.COMPILE_ANDROID_VARIANT, "freeDebug");
    assert.equal(options.outputMode, "stderr");
    assert.equal(options.signal, controller.signal);
    const reportPath = options.env.COMPILE_ANDROID_REPORT;
    assert.ok(reportPath);
    await writeFile(reportPath, JSON.stringify({ paths: [artifact] }));
    return { status: "exited", exitCode: 0, stdout: "", stderr: "" };
  };

  const outputs = await buildAndroid(
    {
      wrapper: { cwd: directory, path: "custom-gradlew" },
      modulePath: ":mobile:app",
      variant: "freeDebug",
      outputType: "apk",
      outputDir: "copied",
      gradleArgs,
    },
    { env, signal: controller.signal, runProcess: runner },
  );

  assert.equal(calls, 1);
  assert.deepEqual(outputs, [path.join(directory, "copied", "app-free-debug.apk")]);
  const [output] = outputs;
  assert.ok(output);
  assert.equal(await readFile(output, "utf8"), "artifact");
  assert.deepEqual(env, { NODE_ENV: "test", CALLER_VALUE: "kept" });
});

void test("uses root-module bundle tasks and preserves native process failures", async () => {
  const request: AndroidBuildRequest = {
    wrapper: { cwd: process.cwd(), path: "gradlew" },
    modulePath: ":",
    variant: "releaseStaging",
    outputType: "aab",
  };
  await assert.rejects(
    buildAndroid(request, {
      runProcess: async (_command, args) => {
        assert.deepEqual(args.slice(0, 2), [":bundleReleaseStaging", "compileAndroidAab"]);
        return { status: "exited", exitCode: 17, stdout: "", stderr: "native build failure" };
      },
    }),
    { exitCode: 17, message: "Gradle failed with exit code 17:\nnative build failure" },
  );
});

void test("passes the batch wrapper and unescaped arguments to the caller's runner", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile android & caller-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = path.join(directory, "app.apk");
  await writeFile(artifact, "artifact");
  const wrapperPath = path.join(directory, "gradlew.bat");
  const property = "-Pvalue=two words & another value";
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  context.after(() => Object.defineProperty(process, "platform", { value: platform }));
  const paths = await buildAndroid(
    {
      wrapper: { cwd: directory, path: wrapperPath },
      modulePath: ":app",
      variant: "debug",
      outputType: "apk",
      gradleArgs: [property],
    },
    {
      runProcess: async (command, args, options) => {
        assert.equal(command, wrapperPath);
        assert.deepEqual(args.slice(0, 3), [":app:assembleDebug", "compileAndroidApk", property]);
        assert.ok(options.env?.COMPILE_ANDROID_REPORT);
        await writeFile(options.env.COMPILE_ANDROID_REPORT, JSON.stringify({ paths: [artifact] }));
        return { status: "exited", exitCode: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.deepEqual(paths, [artifact]);
});

void test("rejects malformed resolved Android selectors before starting Gradle", async () => {
  for (const [modulePath, variant] of [
    ["app", "debug"],
    [":app:", "debug"],
    [":app", ""],
    [":app", "debug:other"],
  ]) {
    assert.ok(modulePath !== undefined && variant !== undefined);
    await assert.rejects(
      buildAndroid(
        {
          wrapper: { cwd: process.cwd(), path: "gradlew" },
          modulePath,
          variant,
          outputType: "apk",
        },
        { runProcess: async () => assert.fail("Gradle must not start.") },
      ),
      /Invalid (?:Gradle module path|Android variant)/,
    );
  }
});

void test(
  "validates standalone React Native modes across cache reuse and keeps resolved variants caller-owned",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-react-selection-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await addReactPluginFixture(project, ["DeBuG"]);
    const lifecycleTasks = ["assembleDebug", "assembleRelease", "assembleDebugOptimized"];
    await addLifecycleReceipts(project, lifecycleTasks);
    const env = { ...process.env };
    delete env["__EXPO_CONFIG_MODE"];
    let output = "";
    const runner: ProcessRunner = async (command, args, options) => {
      const gradleCommand = createGradleCommand(command, args);
      const result = await runProcess(gradleCommand.command, gradleCommand.args, {
        ...options,
        outputMode: "capture",
      });
      output = result.stdout + result.stderr;
      return result;
    };

    for (const [mode, variant] of [
      ["development", "debug"],
      ["production", "release"],
      ["development", "debug"],
    ] as const) {
      const paths = await compileAndroid(
        {
          platform: "android",
          cwd: project,
          mode,
          outputType: "apk",
          outputDir: undefined,
        },
        { env, runProcess: runner },
      );
      assert.equal(paths.length, 3);
      assert.ok(
        paths.every(
          (artifact) =>
            path.basename(artifact).endsWith(`-${variant}.apk`) ||
            path.basename(artifact).endsWith(`-${variant}-unsigned.apk`),
        ),
      );
      await verifyArchives(paths);
    }
    assert.match(output, /Configuration cache entry reused/);

    await appendFile(
      path.join(project, "app", "build.gradle"),
      '\nreact.debuggableVariants.set(["release"])\n',
    );
    for (const lifecycle of lifecycleTasks) {
      await rm(path.join(project, "app", "build", `${lifecycle}.txt`), { force: true });
    }
    for (const [mode, variant, actualMode] of [
      ["development", "debug", "production"],
      ["production", "release", "development"],
    ] as const) {
      await assert.rejects(
        compileAndroid(
          {
            platform: "android",
            cwd: project,
            mode,
            outputType: "apk",
            outputDir: undefined,
          },
          { env, runProcess: runner },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(
            error.message.includes(
              `Android variant '${variant}' uses ${actualMode} according to react.debuggableVariants, but the requested mode is ${mode}.`,
            ),
            error.message,
          );
          return true;
        },
      );
    }
    for (const lifecycle of lifecycleTasks) {
      await assert.rejects(readFile(path.join(project, "app", "build", `${lifecycle}.txt`)), {
        code: "ENOENT",
      });
    }

    const resolved = await buildAndroid(
      {
        wrapper: {
          cwd: project,
          path: process.platform === "win32" ? "gradlew.bat" : "gradlew",
        },
        modulePath: ":app",
        variant: "debugOptimized",
        outputType: "apk",
      },
      { env, runProcess: runner },
    );
    assert.equal(resolved.length, 3);
    assert.ok(resolved.every((artifact) => artifact.endsWith("-debugOptimized.apk")));
    await verifyArchives(resolved);
  },
);

for (const debuggableVariants of [[], ["debugOptimized"]] as const) {
  void test(
    `rejects standalone development when react.debuggableVariants is ${JSON.stringify(debuggableVariants)}`,
    { skip: !hasAndroidSdk },
    async (context) => {
      const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-react-mismatch-"));
      context.after(() => rm(project, { recursive: true, force: true }));
      await copyFixture(fixture, project);
      await addReactPluginFixture(project, debuggableVariants);
      const lifecycleTasks = ["assembleDebug", "assembleDebugOptimized"];
      await addLifecycleReceipts(project, lifecycleTasks);

      await assert.rejects(
        compileAndroid({
          platform: "android",
          cwd: project,
          mode: "development",
          outputType: "apk",
          outputDir: undefined,
        }),
        /Android variant 'debug' uses production according to react\.debuggableVariants, but the requested mode is development\./,
      );
      for (const lifecycle of lifecycleTasks) {
        await assert.rejects(readFile(path.join(project, "app", "build", `${lifecycle}.txt`)), {
          code: "ENOENT",
        });
      }
    },
  );
}

void test(
  "matches fixed Android variant names case-insensitively",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-variant-case-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await appendFile(
      path.join(project, "app", "build.gradle"),
      `
android.buildTypes {
  DeBuG { initWith debug }
  ReLeAsE { initWith release }
}
androidComponents.beforeVariants(androidComponents.selector().all()) { variant ->
  variant.enable = variant.name in ["DeBuG", "ReLeAsE"]
}
`,
    );

    for (const [mode, variant] of [
      ["development", "DeBuG"],
      ["production", "ReLeAsE"],
    ] as const) {
      const paths = await compileAndroid({
        platform: "android",
        cwd: project,
        mode,
        outputType: "apk",
        outputDir: undefined,
      });
      assert.equal(paths.length, 3);
      assert.ok(
        paths.every(
          (artifact) =>
            path.basename(artifact).endsWith(`-${variant}.apk`) ||
            path.basename(artifact).endsWith(`-${variant}-unsigned.apk`),
        ),
      );
      await verifyArchives(paths);
      const resolvedPaths = await buildAndroid({
        wrapper: {
          cwd: project,
          path: process.platform === "win32" ? "gradlew.bat" : "gradlew",
        },
        modulePath: ":app",
        variant: mode === "development" ? "DEBUG" : "release",
        outputType: "apk",
        gradleArgs: ["--configure-on-demand", "--console=plain"],
      });
      assert.deepEqual(resolvedPaths, paths);
    }
  },
);

void test(
  "resolves Android variant casing without changing the selected lifecycle",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-resolved-case-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await addLifecycleReceipts(project, [
      "assembleDebug",
      "assembleRelease",
      "bundleRelease",
      "assembleDebugOptimized",
    ]);
    const wrapper = {
      cwd: project,
      path: process.platform === "win32" ? "gradlew.bat" : "gradlew",
    };
    for (const [variant, outputType, canonicalVariant, lifecycle] of [
      ["DEBUG", "apk", "debug", "assembleDebug"],
      ["Release", "apk", "release", "assembleRelease"],
      ["RELEASE", "aab", "release", "bundleRelease"],
      ["DEBUGOPTIMIZED", "apk", "debugOptimized", "assembleDebugOptimized"],
    ] as const) {
      const paths = await buildAndroid({
        wrapper,
        modulePath: ":app",
        variant,
        outputType,
        gradleArgs: ["--configure-on-demand", "--console=plain"],
      });
      assert.equal(paths.length, outputType === "apk" ? 3 : 1);
      assert.ok(
        paths.every((artifact) => path.basename(path.dirname(artifact)) === canonicalVariant),
      );
      await verifyArchives(paths);
      assert.equal(
        await readFile(path.join(project, "app", "build", `${lifecycle}.txt`), "utf8"),
        lifecycle,
      );
    }
  },
);

void test(
  "rejects Android variants that differ only by case before building",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-ambiguous-case-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await appendFile(
      path.join(project, "app", "build.gradle"),
      `
android.buildTypes {
  deBug { initWith debug }
}
`,
    );
    const lifecycleTasks = ["assembleDebug", "assembleDeBug"];
    await addLifecycleReceipts(project, lifecycleTasks);
    for (const [variant, diagnostic, candidates] of [
      [
        "debug",
        "Compile found 2 Android application variants matching debug in module :app:",
        [":app:debug", ":app:deBug"],
      ],
      ["DEBUG", "task 'assembleDEBUG' is ambiguous", ["'assembleDebug'", "'assembleDeBug'"]],
    ] as const) {
      await assert.rejects(
        buildAndroid(
          {
            wrapper: {
              cwd: project,
              path: process.platform === "win32" ? "gradlew.bat" : "gradlew",
            },
            modulePath: ":app",
            variant,
            outputType: "apk",
            gradleArgs: ["--configure-on-demand", "--console=plain"],
          },
          { outputMode: "quiet" },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(diagnostic), error.message);
          for (const candidate of candidates) {
            assert.ok(error.message.includes(candidate), error.message);
          }
          return true;
        },
      );
      for (const lifecycle of lifecycleTasks) {
        await assert.rejects(readFile(path.join(project, "app", "build", `${lifecycle}.txt`)), {
          code: "ENOENT",
        });
      }
    }
  },
);

void test(
  "runs assemble and bundle actions for standalone Android builds",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-lifecycle-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await addLifecycleReceipts(project, ["assembleDebug", "bundleRelease"]);

    for (const [mode, outputType, lifecycle] of [
      ["development", "apk", "assembleDebug"],
      ["production", "aab", "bundleRelease"],
    ] as const) {
      const paths = await compileAndroid({
        platform: "android",
        cwd: project,
        mode,
        outputType,
        outputDir: undefined,
      });
      await verifyArchives(paths);
      assert.equal(
        await readFile(path.join(project, "app", "build", `${lifecycle}.txt`), "utf8"),
        lifecycle,
      );
    }
  },
);

void test(
  "builds selected Android flavors and optimized variants with configuration cache",
  { skip: !hasAndroidSdk },
  async (context) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "compile-android-resolved-"));
    context.after(() => rm(project, { recursive: true, force: true }));
    await copyFixture(fixture, project);
    await appendFile(
      path.join(project, "app", "build.gradle"),
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
    await addLifecycleReceipts(project, [
      "assembleFreeDebug",
      "assemblePaidDebugOptimized",
      "bundlePaidRelease",
    ]);
    const wrapper = {
      cwd: project,
      path: process.platform === "win32" ? "gradlew.bat" : "gradlew",
    };
    let output = "";
    const runner: ProcessRunner = async (command, args, options) => {
      const gradleCommand = createGradleCommand(command, args);
      const result = await runProcess(gradleCommand.command, gradleCommand.args, {
        ...options,
        outputMode: "capture",
      });
      output = result.stdout + result.stderr;
      return result;
    };
    for (const [variant, outputType, lifecycle] of [
      ["freeDebug", "apk", "assembleFreeDebug"],
      ["paidDebugOptimized", "apk", "assemblePaidDebugOptimized"],
      ["paidRelease", "aab", "bundlePaidRelease"],
      ["freeDebug", "apk", "assembleFreeDebug"],
    ] as const) {
      const paths = await buildAndroid(
        {
          wrapper,
          modulePath: ":app",
          variant,
          outputType,
          gradleArgs: ["--configure-on-demand", "--console=plain"],
        },
        { runProcess: runner },
      );
      assert.equal(paths.length, outputType === "apk" ? 3 : 1);
      assert.ok(
        paths.every((artifact) => artifact.includes(variant.startsWith("free") ? "free" : "paid")),
      );
      if (variant === "paidDebugOptimized")
        assert.ok(paths.every((artifact) => /debugOptimized/i.test(artifact)));
      await verifyArchives(paths);
      assert.equal(
        await readFile(path.join(project, "app", "build", `${lifecycle}.txt`), "utf8"),
        lifecycle,
      );
    }
    assert.match(output, /Configuration cache entry reused/);
  },
);

async function addReactPluginFixture(
  project: string,
  debuggableVariants: readonly string[],
): Promise<void> {
  const buildSrc = path.join(project, "buildSrc");
  const javaSource = path.join(buildSrc, "src", "main", "java");
  await mkdir(javaSource, { recursive: true });
  await writeFile(
    path.join(buildSrc, "build.gradle"),
    `plugins { id "java-gradle-plugin" }
gradlePlugin {
  plugins {
    fixtureReact {
      id = "com.facebook.react"
      implementationClass = "FixtureReactPlugin"
    }
  }
}
`,
  );
  await writeFile(
    path.join(javaSource, "FixtureReactPlugin.java"),
    `import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.provider.ListProperty;

public final class FixtureReactPlugin implements Plugin<Project> {
  public abstract static class ReactExtension {
    public abstract ListProperty<String> getDebuggableVariants();
  }

  @Override
  public void apply(Project project) {
    project.getExtensions().create("react", ReactExtension.class);
  }
}
`,
  );
  await appendFile(
    path.join(project, "app", "build.gradle"),
    `
apply plugin: "com.facebook.react"
react.debuggableVariants.set(${JSON.stringify(debuggableVariants)})
`,
  );
}

async function addLifecycleReceipts(project: string, taskNames: readonly string[]): Promise<void> {
  await appendFile(
    path.join(project, "app", "build.gradle"),
    `
tasks.matching { it.name in ${JSON.stringify(taskNames)} }.configureEach { task ->
  def name = task.name
  def receipt = layout.buildDirectory.file(name + ".txt")
  task.doLast { receipt.get().asFile.text = name }
}
`,
  );
}

async function verifyArchives(paths: readonly string[]): Promise<void> {
  assert.ok(paths.length > 0);
  for (const artifact of paths) {
    const bytes = await readFile(artifact);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, `${artifact} has no ZIP header.`);
  }
}
