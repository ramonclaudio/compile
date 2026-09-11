import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDistinctArtifactNames,
  createOutputDirectory,
  outputDirectoryError,
} from "./artifacts.ts";
import { createBuildEnvironment, runCheckedProcess } from "./process.ts";
import type { NativeBuildOptions } from "./process.ts";
import { CompileError } from "./types.ts";
import type { AndroidCompileRequest, AndroidOutputType } from "./types.ts";
import { isMissingPathError, isRecord, isStringArray } from "./validation.ts";

const initScriptPath = fileURLToPath(new URL("../gradle/android.gradle", import.meta.url));
const gradleTaskNames = {
  development: {
    apk: "compileAndroidDevelopmentApk",
    aab: "compileAndroidDevelopmentAab",
  },
  production: {
    apk: "compileAndroidProductionApk",
    aab: "compileAndroidProductionAab",
  },
} as const;

export interface GradleWrapper {
  readonly cwd: string;
  readonly path: string;
}

export interface GradleCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface AndroidBuildRequest {
  readonly wrapper: GradleWrapper;
  readonly modulePath: string;
  readonly variant: string;
  readonly outputType: AndroidOutputType;
  readonly expectedArchitectures?: readonly string[];
  readonly outputDir?: string;
  readonly gradleArgs?: readonly string[];
}

export async function compileAndroid(
  request: AndroidCompileRequest,
  options: NativeBuildOptions = {},
): Promise<readonly string[]> {
  request = {
    ...request,
    cwd: path.resolve(request.cwd),
    outputDir:
      request.outputDir === undefined ? undefined : path.resolve(request.cwd, request.outputDir),
  };
  const wrapper = await resolveGradleWrapper(request.cwd);
  const taskName = gradleTaskNames[request.mode][request.outputType];
  return buildAndroidArtifacts(
    wrapper,
    [taskName, "--console=plain", "--no-configure-on-demand"],
    request.outputType,
    request.outputDir,
    request.expectedArchitectures,
    { ...options, env: createBuildEnvironment(request.mode, options.env) },
  );
}

export async function buildAndroid(
  request: AndroidBuildRequest,
  options: NativeBuildOptions = {},
): Promise<readonly string[]> {
  const lifecycleTask = androidLifecycleTask(request);
  const wrapper = {
    cwd: path.resolve(request.wrapper.cwd),
    path: path.resolve(request.wrapper.cwd, request.wrapper.path),
  };
  return buildAndroidArtifacts(
    wrapper,
    [
      lifecycleTask,
      request.outputType === "apk" ? "compileAndroidApk" : "compileAndroidAab",
      ...(request.gradleArgs ?? []),
    ],
    request.outputType,
    request.outputDir === undefined ? undefined : path.resolve(wrapper.cwd, request.outputDir),
    request.expectedArchitectures,
    {
      ...options,
      env: {
        ...(options.env ?? process.env),
        COMPILE_ANDROID_MODULE: request.modulePath,
        COMPILE_ANDROID_VARIANT: request.variant,
      },
    },
  );
}

function androidLifecycleTask(request: AndroidBuildRequest): string {
  if (!/^:(?:[^:]+(?::[^:]+)*)?$/.test(request.modulePath)) {
    throw new CompileError(`Invalid Gradle module path: ${request.modulePath}`);
  }
  if (request.variant.length === 0 || request.variant.includes(":")) {
    throw new CompileError(`Invalid Android variant: ${request.variant}`);
  }
  const prefix = request.outputType === "apk" ? "assemble" : "bundle";
  const variant = request.variant.charAt(0).toUpperCase() + request.variant.slice(1);
  return `${request.modulePath === ":" ? "" : request.modulePath}:${prefix}${variant}`;
}

async function buildAndroidArtifacts(
  wrapper: GradleWrapper,
  args: readonly string[],
  outputType: AndroidOutputType,
  outputDir: string | undefined,
  expectedArchitectures: readonly string[] | undefined,
  options: NativeBuildOptions,
): Promise<readonly string[]> {
  validateExpectedArchitectures(expectedArchitectures, outputType);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-android-"));
  const reportPath = path.join(temporaryDirectory, "artifacts.json");

  try {
    const env = { ...(options.env ?? process.env) };
    if (expectedArchitectures === undefined) {
      delete env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES;
    } else {
      env.COMPILE_ANDROID_EXPECTED_ARCHITECTURES = expectedArchitectures.join(",");
    }
    await runGradle(wrapper, args, reportPath, { ...options, env });
    const artifactPaths = await readArtifactPaths(reportPath, outputType);
    await verifyAndroidArtifactPaths(artifactPaths, outputType);
    return await copyAndroidArtifacts(artifactPaths, outputDir, outputType);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function validateExpectedArchitectures(
  architectures: readonly string[] | undefined,
  outputType: AndroidOutputType,
): void {
  if (architectures === undefined) return;
  if (outputType !== "apk") {
    throw new CompileError("Expected Android architectures can only be checked for APK output.");
  }
  if (
    architectures.length === 0 ||
    Array.from(architectures).some(
      (architecture) => typeof architecture !== "string" || !/^[A-Za-z0-9_-]+$/.test(architecture),
    )
  ) {
    throw new CompileError(
      "Expected Android architectures must be a nonempty list of names containing only letters, numbers, underscores, or hyphens.",
    );
  }
}

export async function resolveGradleWrapper(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<GradleWrapper> {
  const wrapperName = platform === "win32" ? "gradlew.bat" : "gradlew";
  const roots = [path.resolve(cwd), path.resolve(cwd, "android")];
  const wrappers: GradleWrapper[] = [];

  for (const root of roots) {
    const wrapperPath = path.join(root, wrapperName);
    if ((await statIfExists(wrapperPath))?.isFile()) {
      wrappers.push({ cwd: root, path: wrapperPath });
    }
  }
  const [wrapper] = wrappers;
  if (wrappers.length === 1 && wrapper !== undefined) return wrapper;
  if (wrappers.length === 0) {
    throw new CompileError(`No ${wrapperName} found in the current directory or android/.`);
  }
  throw new CompileError(
    `Found more than one ${wrapperName}:\n${wrappers.map((item) => `- ${item.path}`).join("\n")}\nCompile requires exactly one Gradle Wrapper.`,
  );
}

export function createGradleCommand(
  wrapperPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  commandPrompt: string = process.env.ComSpec ?? "cmd.exe",
): GradleCommand {
  if (platform !== "win32") return { command: wrapperPath, args };
  return {
    command: commandPrompt,
    args: ["/d", "/c", wrapperPath, ...args],
  };
}

export function parseAndroidArtifactReport(
  reportText: string,
  outputType: AndroidOutputType,
): readonly string[] {
  let report: unknown;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw invalidArtifactReport(error);
  }
  if (!isRecord(report) || !isStringArray(report.paths)) {
    throw invalidArtifactReport();
  }

  const paths = report.paths;
  const expectedExtension = `.${outputType}`;
  const validPaths = paths.every(
    (artifactPath) =>
      path.isAbsolute(artifactPath) && path.extname(artifactPath) === expectedExtension,
  );
  if (!validPaths || paths.length === 0 || new Set(paths).size !== paths.length) {
    throw invalidArtifactReport();
  }
  if (outputType === "aab" && paths.length !== 1) {
    throw invalidArtifactReport();
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export async function verifyAndroidArtifactPaths(
  artifactPaths: readonly string[],
  outputType: AndroidOutputType,
): Promise<void> {
  for (const artifactPath of artifactPaths) {
    const file = await statIfExists(artifactPath);
    if (file?.isFile() && file.size > 0) continue;
    throw new CompileError(
      `Gradle exited with code 0, but ${artifactPath} is not a nonempty ${outputType.toUpperCase()} file.`,
    );
  }
}

export async function copyAndroidArtifacts(
  artifactPaths: readonly string[],
  outputDir: string | undefined,
  outputType: AndroidOutputType,
): Promise<readonly string[]> {
  if (outputDir === undefined) return artifactPaths;
  const outputPaths = artifactPaths.map((artifactPath) =>
    path.join(outputDir, path.basename(artifactPath)),
  );
  await createOutputDirectory(outputDir);
  await assertDistinctArtifactNames(artifactPaths, outputDir);
  const canonicalOutputDir = await realpath(outputDir).catch((error: unknown) => {
    throw outputDirectoryError(outputDir, error);
  });
  const copies = await Promise.all(
    artifactPaths.map(async (artifactPath) => {
      const outputPath = path.join(canonicalOutputDir, path.basename(artifactPath));
      const canonicalOutputPath = await realpath(outputPath).catch((error: unknown) => {
        if (isMissingPathError(error)) return outputPath;
        throw outputDirectoryError(outputDir, error);
      });
      return { sourcePath: await realpath(artifactPath), outputPath, canonicalOutputPath };
    }),
  );
  for (const copy of copies) {
    if (copy.sourcePath === copy.canonicalOutputPath) continue;
    if (copies.some((source) => source.sourcePath === copy.canonicalOutputPath)) {
      throw new CompileError(`Output path ${copy.outputPath} overlaps a source artifact.`);
    }
  }
  for (const copy of copies) {
    if (copy.sourcePath === copy.canonicalOutputPath) continue;
    await copyArtifact(copy.sourcePath, copy.outputPath, outputType);
  }
  await verifyAndroidArtifactPaths(outputPaths, outputType);
  return outputPaths;
}

async function runGradle(
  wrapper: GradleWrapper,
  args: readonly string[],
  reportPath: string,
  options: NativeBuildOptions,
): Promise<void> {
  const gradleArgs = [...args, "--init-script", initScriptPath];
  const gradleCommand =
    options.runProcess === undefined
      ? createGradleCommand(wrapper.path, gradleArgs)
      : { command: wrapper.path, args: gradleArgs };
  await runCheckedProcess(
    gradleCommand.command,
    gradleCommand.args,
    {
      cwd: wrapper.cwd,
      env: {
        ...(options.env ?? process.env),
        COMPILE_ANDROID_REPORT: reportPath,
      },
      outputMode: options.outputMode ?? "stderr",
      signal: options.signal,
    },
    "Gradle",
    options.runProcess,
  ).catch((error: unknown) => {
    if (process.platform === "win32" || !(error instanceof CompileError)) throw error;
    const cause = error.cause;
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EACCES") throw error;
    throw new CompileError(
      `Cannot execute Gradle Wrapper ${wrapper.path}. Check its permissions and make it executable with chmod +x.`,
      { cause: error },
    );
  });
}

async function readArtifactPaths(
  reportPath: string,
  outputType: AndroidOutputType,
): Promise<readonly string[]> {
  try {
    return parseAndroidArtifactReport(await readFile(reportPath, "utf8"), outputType);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new CompileError("Gradle exited with code 0, but it did not report an artifact.", {
        cause: error,
      });
    }
    throw error;
  }
}

async function copyArtifact(
  sourcePath: string,
  outputPath: string,
  outputType: AndroidOutputType,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.compile-${randomUUID()}.${outputType}`,
  );
  try {
    await copyFile(sourcePath, temporaryPath);
    await verifyAndroidArtifactPaths([temporaryPath], outputType);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (error instanceof CompileError) throw error;
    throw new CompileError(`Could not copy ${sourcePath} to ${outputPath}.`, { cause: error });
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function invalidArtifactReport(cause?: unknown): CompileError {
  return new CompileError("Gradle returned invalid artifact data.", { cause });
}

async function statIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}
