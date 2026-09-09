import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

void test("prepares and consumes the packed library and CLI from an isolated project", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "compile package & consumer-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const packageDirectory = path.join(directory, "package");
  const consumer = path.join(directory, "consumer");
  await mkdir(packageDirectory);
  for (const name of [
    "src",
    "gradle",
    "package.json",
    "README.md",
    "LICENSE",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    await cp(path.join(projectRoot, name), path.join(packageDirectory, name), { recursive: true });
  }
  await symlink(
    await realpath(path.join(projectRoot, "node_modules")),
    path.join(packageDirectory, "node_modules"),
    "junction",
  );
  await assert.rejects(access(path.join(packageDirectory, "dist")), { code: "ENOENT" });
  const env = {
    ...process.env,
    npm_config_cache: path.join(directory, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  const npmCli =
    process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : await realpath(path.join(path.dirname(process.execPath), "npm"));
  await execute(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts=false", "--pack-destination", directory],
    {
      cwd: packageDirectory,
      env,
    },
  );
  await access(path.join(packageDirectory, "dist", "index.js"));
  await access(path.join(packageDirectory, "dist", "cli.js"));
  const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = tarballs[0];
  assert.ok(tarball);
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true }));
  await execute(
    process.execPath,
    [
      npmCli,
      "install",
      path.join(directory, tarball),
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: consumer, env },
  );

  await context.test(
    "ESM and CommonJS share the API and error class without starting the CLI",
    async () => {
      const result = await runConsumer(
        "imports.mjs",
        `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
const argv = [...process.argv];
const environment = { ...process.env };
const esm = await import("@ramonclaudio/compile");
const commonjs = createRequire(import.meta.url)("@ramonclaudio/compile");
for (const name of ["compileAndroid", "compileIos", "buildAndroid", "buildIos", "runProcess", "CompileError"]) {
  assert.equal(typeof esm[name], "function");
  assert.equal(esm[name], commonjs[name]);
}
await assert.rejects(esm.buildAndroid({
  wrapper: { cwd: process.cwd(), path: "gradlew" },
  modulePath: "invalid", variant: "debug", outputType: "apk",
}), error => {
  assert.ok(error instanceof commonjs.CompileError);
  assert.match(error.message, /Invalid Gradle module path/);
  return true;
});
assert.deepEqual(process.argv, argv);
assert.ok(isDeepStrictEqual({ ...process.env }, environment), "Package import changed the environment");
`,
      );
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    },
  );

  await context.test("the installed CLI bin shows help", async () => {
    const result = await execute(
      process.execPath,
      [npmCli, "exec", "--offline", "--", "compile", "--help"],
      {
        cwd: consumer,
        env,
      },
    );
    assert.match(result.stdout, /compile ios/);
    assert.match(result.stdout, /compile android/);
    assert.equal(result.stderr, "");
  });

  await context.test(
    "a library build finds the packaged Gradle script and returns its artifacts",
    async () => {
      const gradleSource = await readFile(
        path.join(projectRoot, "gradle", "android.gradle"),
        "utf8",
      );
      const result = await runConsumer(
        "android.mjs",
        `
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAndroid, compileAndroid } from "@ramonclaudio/compile";
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@ramonclaudio/compile"))));
const artifact = path.join(process.cwd(), "app.apk");
await writeFile(artifact, "packaged consumer artifact");
await writeFile(path.join(process.cwd(), process.platform === "win32" ? "gradlew.bat" : "gradlew"), "");
let calls = 0;
const options = {
  env: Object.freeze({ COMPILE_TEST_VALUE: "caller", NODE_ENV: "test" }),
  runProcess: async (_command, args, options) => {
    calls += 1;
    assert.equal(args[0], calls === 1 ? ":app:assembleFreeDebug" : "compileAndroidDevelopmentApk");
    assert.equal(options.env.COMPILE_TEST_VALUE, "caller");
    assert.equal(options.env.NODE_ENV, calls === 1 ? "test" : "development");
    const script = args[args.indexOf("--init-script") + 1];
    assert.equal(script, path.join(packageRoot, "gradle", "android.gradle"));
    assert.equal(await readFile(script, "utf8"), ${JSON.stringify(gradleSource)});
    assert.ok(options.env.COMPILE_ANDROID_REPORT);
    await writeFile(options.env.COMPILE_ANDROID_REPORT, JSON.stringify({ paths: [artifact] }));
    return { status: "exited", exitCode: 0, stdout: "", stderr: "" };
  },
};
const paths = await buildAndroid({
  wrapper: { cwd: process.cwd(), path: "gradlew" },
  modulePath: ":app", variant: "freeDebug", outputType: "apk",
}, options);
assert.deepEqual(paths, [artifact]);
assert.deepEqual(await compileAndroid({
  platform: "android", cwd: process.cwd(), mode: "development", outputType: "apk", outputDir: undefined,
}, options), [artifact]);
assert.equal(calls, 2);
assert.equal(options.env.NODE_ENV, "test");
`,
      );
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    },
  );

  await context.test(
    "packed declarations support both module systems and reject wrong output types",
    async () => {
      const source = `
import {
  buildAndroid, buildIos, compileAndroid, compileIos, runProcess, CompileError,
  type AndroidBuildRequest, type IosBuildRequest, type GradleWrapper,
  type AndroidCompileRequest, type IosCompileRequest, type CompileRequest,
  type NativeBuildOptions, type ProcessResult, type ProcessRunner, type RunProcessOptions,
  type BuildMode, type AndroidOutputType, type IosOutputType,
  type IosBuildPlatform, type IosDestination, type IosSource,
} from "@ramonclaudio/compile";
const mode: BuildMode = "development";
const androidOutput: AndroidOutputType = "apk";
const iosOutput: IosOutputType = "app";
const configuration = "Debug";
const platform: IosBuildPlatform = "iphonesimulator";
const destination: IosDestination = { kind: "simulator" };
const source: IosSource = { kind: "project", path: "App.xcodeproj" };
const wrapper: GradleWrapper = { cwd: "/app", path: "gradlew" };
const android: AndroidBuildRequest = { wrapper, modulePath: ":app", variant: "debug", outputType: androidOutput };
const ios: IosBuildRequest = { cwd: "/app", source, scheme: "App", configuration, platform, destination: "generic/platform=iOS Simulator" };
const androidCompile: AndroidCompileRequest = { platform: "android", cwd: "/app", mode, outputType: androidOutput, outputDir: undefined };
const iosCompile: IosCompileRequest = { platform: "ios", cwd: "/app", mode, outputType: iosOutput, outputDir: undefined, destination };
const requests: readonly CompileRequest[] = [androidCompile, iosCompile];
const runner: ProcessRunner = async (command, args, options: RunProcessOptions): Promise<ProcessResult> => runProcess(command, args, options);
const options: NativeBuildOptions = { runProcess: runner, signal: new AbortController().signal, env: {} };
const outputs: Promise<readonly string[]>[] = [buildAndroid(android, options), buildIos(ios, options), compileAndroid(androidCompile, options), compileIos(iosCompile, options)];
const defaults: NativeBuildOptions = { env: undefined, signal: undefined, runProcess: undefined };
compileAndroid(androidCompile, defaults);
compileIos(iosCompile, defaults);
// @ts-expect-error IPA export cannot request a simulator.
const invalidIpa: IosCompileRequest = { platform: "ios", cwd: "/app", mode, outputType: "ipa", destination: { kind: "simulator" }, outputDir: undefined };
void invalidIpa;
const error: Error = new CompileError("native failure", { exitCode: 7 });
void [requests, outputs, error];
`;
      await writeFile(path.join(consumer, "valid.mts"), source);
      await writeFile(path.join(consumer, "valid.cts"), source);
      const compiler = path.join(
        path.dirname(require.resolve("typescript/package.json")),
        "bin",
        "tsc",
      );
      const typeRoots = path.dirname(path.dirname(require.resolve("@types/node/package.json")));
      const compilerArgs = [
        compiler,
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--types",
        "node",
        "--typeRoots",
        typeRoots,
      ];
      await execute(process.execPath, [...compilerArgs, "valid.mts", "valid.cts"], {
        cwd: consumer,
      });
      await writeFile(
        path.join(consumer, "invalid.mts"),
        `
import { compileAndroid } from "@ramonclaudio/compile";
compileAndroid({ platform: "android", cwd: "/app", mode: "development", outputType: "ipa", outputDir: undefined });
`,
      );
      await assert.rejects(
        execute(process.execPath, [...compilerArgs, "invalid.mts"], { cwd: consumer }),
        (error: unknown) => {
          assert.ok(
            error instanceof Error && "stdout" in error && typeof error.stdout === "string",
          );
          assert.match(error.stdout, /Type '"ipa"' is not assignable to type 'AndroidOutputType'/);
          return true;
        },
      );
    },
  );

  async function runConsumer(name: string, source: string) {
    await writeFile(path.join(consumer, name), source);
    return execute(process.execPath, [name], { cwd: consumer, env });
  }
});
