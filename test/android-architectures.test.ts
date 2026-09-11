import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildAndroid, compileAndroid, createGradleCommand } from "../src/android.ts";
import { runProcess } from "../src/process.ts";
import type { NativeBuildOptions } from "../src/process.ts";
import type { AndroidCompileRequest } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const archives = path.join(packageRoot, "test", "fixtures", "android-apks");
const hasJava = process.env.JAVA_HOME !== undefined;
type AndroidApi = "compileAndroid" | "buildAndroid";
type ArchitectureRequest = Pick<AndroidCompileRequest, "outputType" | "expectedArchitectures">;

for (const api of ["compileAndroid", "buildAndroid"] as const) {
  void test(`${api} passes explicit architectures without changing the caller's environment`, async (context) => {
    const directory = await createProject();
    context.after(() => rm(directory, { recursive: true, force: true }));
    const artifact = path.join(directory, "app.apk");
    await copyFile(path.join(archives, "arm64.zip"), artifact);
    const expectedArchitectures = Object.freeze(["arm64-v8a", "future_abi-64"]);
    const env = Object.freeze({ COMPILE_ANDROID_EXPECTED_ARCHITECTURES: "x86", CALLER: "kept" });
    let calls = 0;
    const outputs = await callAndroid(
      api,
      directory,
      { outputType: "apk", expectedArchitectures },
      {
        env,
        runProcess: async (_command, _args, options) => {
          calls += 1;
          assert.equal(
            options.env?.COMPILE_ANDROID_EXPECTED_ARCHITECTURES,
            "arm64-v8a,future_abi-64",
          );
          assert.equal(options.env.CALLER, "kept");
          assert.ok(options.env.COMPILE_ANDROID_REPORT);
          await writeFile(
            options.env.COMPILE_ANDROID_REPORT,
            JSON.stringify({ paths: [artifact] }),
          );
          return { status: "exited", exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(outputs, [path.join(directory, "copied", "app.apk")]);
    assert.deepEqual(env, { COMPILE_ANDROID_EXPECTED_ARCHITECTURES: "x86", CALLER: "kept" });
    assert.deepEqual(expectedArchitectures, ["arm64-v8a", "future_abi-64"]);
  });

  for (const inheritedFrom of ["options", "process"] as const) {
    void test(`${api} ignores an architecture constraint inherited from ${inheritedFrom}`, async (context) => {
      const directory = await createProject();
      context.after(() => rm(directory, { recursive: true, force: true }));
      const artifact = path.join(directory, "app.apk");
      await copyFile(path.join(archives, "arm64.zip"), artifact);
      const previous = process.env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES;
      process.env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES = "x86";
      context.after(() => {
        if (previous === undefined) delete process.env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES;
        else process.env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES = previous;
      });
      const env = { COMPILE_ANDROID_EXPECTED_ARCHITECTURES: "mips" };
      await callAndroid(
        api,
        directory,
        { outputType: "apk" },
        {
          ...(inheritedFrom === "options" ? { env } : {}),
          runProcess: async (_command, _args, options) => {
            assert.equal(options.env?.COMPILE_ANDROID_EXPECTED_ARCHITECTURES, undefined);
            assert.ok(options.env?.COMPILE_ANDROID_REPORT);
            await writeFile(
              options.env.COMPILE_ANDROID_REPORT,
              JSON.stringify({ paths: [artifact] }),
            );
            return { status: "exited", exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.equal(process.env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES, "x86");
      assert.deepEqual(env, { COMPILE_ANDROID_EXPECTED_ARCHITECTURES: "mips" });
    });
  }

  void test(`${api} rejects invalid architecture constraints before starting Gradle`, async (context) => {
    const directory = await createProject();
    context.after(() => rm(directory, { recursive: true, force: true }));
    const sparseArchitectures: string[] = [];
    sparseArchitectures.length = 1;
    for (const expectedArchitectures of [
      [],
      sparseArchitectures,
      [""],
      ["arm64-v8a,x86"],
      ["arm64 v8a"],
      ["../x86"],
      ["x86\n"],
    ]) {
      await assert.rejects(
        callAndroid(
          api,
          directory,
          { outputType: "apk", expectedArchitectures },
          {
            runProcess: async () => assert.fail("Gradle must not start."),
          },
        ),
        /architectur/i,
      );
    }
    await assert.rejects(
      callAndroid(
        api,
        directory,
        { outputType: "aab", expectedArchitectures: ["arm64-v8a"] },
        {
          runProcess: async () => assert.fail("Gradle must not start."),
        },
      ),
      /APK/,
    );
  });

  void test(`${api} preserves existing outputs when Gradle rejects an APK`, async (context) => {
    const directory = await createProject();
    context.after(() => rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, "copied", "app.apk");
    await mkdir(path.dirname(output));
    await writeFile(output, "previous output");
    let reportPath: string | undefined;
    await assert.rejects(
      callAndroid(
        api,
        directory,
        { outputType: "apk", expectedArchitectures: ["arm64-v8a"] },
        {
          runProcess: async (_command, _args, options) => {
            reportPath = options.env?.COMPILE_ANDROID_REPORT;
            return {
              status: "exited",
              exitCode: 1,
              stdout: "",
              stderr: "Cannot inspect Android artifact",
            };
          },
        },
      ),
      /Cannot inspect Android artifact/,
    );
    assert.equal(await readFile(output, "utf8"), "previous output");
    assert.ok(reportPath);
    await assert.rejects(readFile(reportPath), { code: "ENOENT" });
  });
}

void test(
  "checks APK architectures when Gradle reuses its configuration cache",
  {
    skip: !hasJava,
  },
  async (context) => {
    const project = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "compile-apk-validation-")),
    );
    context.after(() => rm(project, { recursive: true, force: true }));
    await writeFile(
      path.join(project, "settings.gradle"),
      'rootProject.name = "compile-apk-validation"\n',
    );
    await mkdir(path.join(project, "apks"));
    const cases = await prepareArchiveCases(project);
    await writeFile(path.join(project, "cases.json"), JSON.stringify(cases));
    const source = await readFile(path.join(packageRoot, "gradle", "android.gradle"), "utf8");
    const classEnd = source.indexOf("if (gradle.parent != null) return");
    assert.ok(classEnd > 0, "The production Gradle task must be loaded into the test project.");
    await writeFile(path.join(project, "build.gradle"), source.slice(0, classEnd) + gradleHarness);
    const report = path.join(project, "cache-report.json");
    const first = await runArchiveHarness(project, "arm64-v8a");
    assert.equal(first.status, "exited");
    assert.equal(first.exitCode, 0, first.stdout + first.stderr);
    for (const fixtureCase of cases) {
      assert.ok(first.stdout.includes(`Verified ${fixtureCase.name}`), first.stdout);
    }
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), {
      paths: [path.join(project, "apks", "arm64.apk")],
    });
    await rm(report);
    const mismatch = await runArchiveHarness(project, "x86");
    assert.equal(mismatch.status, "exited");
    assert.equal(mismatch.exitCode, 1, mismatch.stdout + mismatch.stderr);
    assert.match(mismatch.stdout + mismatch.stderr, /Configuration cache entry reused/);
    assert.match(mismatch.stderr, /contains native libraries for arm64-v8a/);
    assert.match(mismatch.stderr, /requested architectures are x86/);
    await assert.rejects(readFile(report), { code: "ENOENT" });
    const restored = await runArchiveHarness(project, "arm64-v8a");
    assert.equal(restored.status, "exited");
    assert.equal(restored.exitCode, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout + restored.stderr, /Configuration cache entry reused/);
    assert.ok((await readFile(report, "utf8")).includes("arm64.apk"));
  },
);

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile-expected-architectures-"));
  await writeFile(
    path.join(directory, process.platform === "win32" ? "gradlew.bat" : "gradlew"),
    "",
  );
  return directory;
}

async function callAndroid(
  api: AndroidApi,
  directory: string,
  request: ArchitectureRequest,
  options: NativeBuildOptions,
): Promise<readonly string[]> {
  const outputDir = path.join(directory, "copied");
  if (api === "compileAndroid") {
    return compileAndroid(
      { platform: "android", cwd: directory, mode: "development", outputDir, ...request },
      options,
    );
  }
  return buildAndroid(
    {
      wrapper: { cwd: directory, path: "gradlew" },
      modulePath: ":app",
      variant: "debug",
      outputDir,
      ...request,
    },
    options,
  );
}

interface ArchiveCase {
  readonly name: string;
  readonly paths: readonly string[];
  readonly architectures: readonly string[];
  readonly failure: string;
}

async function prepareArchiveCases(project: string): Promise<readonly ArchiveCase[]> {
  const cases: ArchiveCase[] = [];
  for (const [name, failure] of [
    ["arm64", ""],
    ["mixed", ""],
    ["neutral", ""],
    ["ignored-paths", ""],
    ["unicode-path", ""],
    ["x86", "contains native libraries for x86"],
    ["x86_64", "contains native libraries for x86_64"],
    ["mips", "contains native libraries for mips"],
    ["backslash-path", "Cannot inspect Android artifact"],
    ["absolute-path", "Cannot inspect Android artifact"],
    ["drive-path", "Cannot inspect Android artifact"],
    ["drive-newline-path", "Cannot inspect Android artifact"],
    ["parent-path", "Cannot inspect Android artifact"],
    ["invalid-after-match", "Cannot inspect Android artifact"],
    ["malformed-central-entry", "Cannot inspect Android artifact"],
    ["future-architecture", "contains native libraries for future_abi-64"],
  ] as const) {
    const artifact = path.join(project, "apks", `${name}.apk`);
    await copyFile(path.join(archives, `${name}.zip`), artifact);
    cases.push({ name, paths: [artifact], architectures: ["arm64-v8a"], failure });
  }
  const artifact = (name: string) => path.join(project, "apks", `${name}.apk`);
  await writeFile(artifact("invalid-zip"), "not a ZIP archive");
  cases.push(
    {
      name: "invalid-zip",
      paths: [artifact("invalid-zip")],
      architectures: ["arm64-v8a"],
      failure: "Cannot inspect Android artifact",
    },
    {
      name: "missing",
      paths: [artifact("missing")],
      architectures: ["arm64-v8a"],
      failure: "Cannot inspect Android artifact",
    },
    {
      name: "each-apk",
      paths: [artifact("arm64"), artifact("x86")],
      architectures: ["arm64-v8a"],
      failure: `Android artifact "${artifact("x86")}"`,
    },
    {
      name: "compatible-and-neutral",
      paths: [artifact("neutral"), artifact("x86_64")],
      architectures: ["arm64-v8a", "x86_64"],
      failure: "",
    },
    {
      name: "future-supported",
      paths: [artifact("future-architecture")],
      architectures: ["future_abi-64"],
      failure: "",
    },
    { name: "disabled", paths: [artifact("invalid-zip")], architectures: [], failure: "" },
  );
  return cases;
}

async function runArchiveHarness(project: string, architectures: string) {
  const command = createGradleCommand(
    path.join(
      packageRoot,
      "fixtures",
      "android-java",
      process.platform === "win32" ? "gradlew.bat" : "gradlew",
    ),
    [
      "-p",
      project,
      "verifyFixtures",
      "checkExpectedArchitectures",
      "--offline",
      "--configuration-cache",
      "--rerun-tasks",
      "--console=plain",
      "--max-workers=2",
    ],
  );
  return runProcess(command.command, command.args, {
    cwd: project,
    env: { ...process.env, COMPILE_TEST_ARCHITECTURES: architectures },
    outputMode: "capture",
    signal: undefined,
  });
}

const gradleHarness = `
class FixtureArtifactLoader implements Serializable {
  List<String> paths

  Object load(Object directory) {
    return [elements: paths.collect { [outputFile: it] }]
  }
}

abstract class VerifyApkTask extends CompileAndroidArtifactTask {
  @Input
  abstract Property<String> getExpectedFailure()

  @TaskAction
  @Override
  void writeReport() {
    def report = reportFile.get().asFile
    report.delete()
    def expected = expectedFailure.get()
    def failure = null
    try {
      super.writeReport()
    } catch (Exception error) {
      failure = error
    }
    if (expected.isEmpty()) {
      assert failure == null : failure
      def parsed = new groovy.json.JsonSlurper().parse(report)
      assert parsed.paths == artifactsLoader.get().paths
    } else {
      assert failure != null : "Expected archive validation to fail"
      assert failure.message.contains(expected) : failure.message
      assert !report.exists() : "Rejected APKs must not be reported"
    }
    println "Verified " + name.substring("verify_".length())
  }
}

def cases = new groovy.json.JsonSlurper().parse(file("cases.json"))
def verifications = cases.collect { fixtureCase ->
  tasks.register("verify_" + fixtureCase.name, VerifyApkTask) {
    outputType.set("apk")
    apkDirectory.set(layout.projectDirectory.dir("apks"))
    artifactsLoader.set(new FixtureArtifactLoader(paths: fixtureCase.paths))
    expectedArchitectures.set(fixtureCase.architectures)
    expectedFailure.set(fixtureCase.failure)
    reportFile.set(layout.projectDirectory.file("report-" + fixtureCase.name + ".json"))
  }
}
tasks.register("verifyFixtures") { dependsOn(verifications) }
tasks.register("checkExpectedArchitectures", CompileAndroidArtifactTask) {
  outputType.set("apk")
  apkDirectory.set(layout.projectDirectory.dir("apks"))
  artifactsLoader.set(new FixtureArtifactLoader(paths: [file("apks/arm64.apk").absolutePath]))
  expectedArchitectures.set(providers.environmentVariable("COMPILE_TEST_ARCHITECTURES").map { it.split(",").toList() })
  reportFile.set(layout.projectDirectory.file("cache-report.json"))
}
`;
