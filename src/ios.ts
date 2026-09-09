import { lstat, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertDistinctArtifactNames,
  createOutputDirectory,
  createOutputTemporaryDirectory,
  outputDirectoryError,
} from "./artifacts.ts";
import { exportIpa, readExportOptions } from "./ios-export.ts";
import { createBuildEnvironment, runCheckedProcess } from "./process.ts";
import type { NativeBuildOptions } from "./process.ts";
import { CompileError } from "./types.ts";
import type { IosBuildPlatform, IosCompileRequest, IosDestination, IosSource } from "./types.ts";
import { isMissingPathError, isRecord, isStringArray } from "./validation.ts";

type IosBuildConfiguration = "Debug" | "Release";

const xcrun = "/usr/bin/xcrun";
const ditto = "/usr/bin/ditto";
const platformFamilies = {
  iphoneos: "ios",
  iphonesimulator: "ios",
  appletvos: "tvos",
  appletvsimulator: "tvos",
  watchos: "watchos",
  watchsimulator: "watchos",
  xros: "visionos",
  xrsimulator: "visionos",
} satisfies Record<IosBuildPlatform, string>;

export interface IosBuildRequest {
  readonly cwd: string;
  readonly source: IosSource;
  readonly scheme: string;
  readonly configuration: string;
  readonly destination: string;
  readonly platform: IosBuildPlatform;
  readonly buildArgs?: readonly string[];
  readonly clean?: boolean;
  readonly outputDir?: string;
}

type IosExecutionRequest = Omit<IosBuildRequest, "platform"> & {
  readonly platform: IosBuildPlatform | undefined;
};

interface IosDirectory {
  readonly path: string;
  readonly hasPodfile: boolean;
  readonly hasPods: boolean;
  readonly projects: readonly IosSource[];
  readonly workspaces: readonly IosSource[];
}

interface AppCopy {
  readonly sourcePath: string;
  readonly outputPath: string;
}

export async function compileIos(
  request: IosCompileRequest,
  options: NativeBuildOptions = {},
): Promise<readonly string[]> {
  if (request.outputType === "ipa") assertDeviceDestination(request.destination);
  request = {
    ...request,
    cwd: path.resolve(request.cwd),
    outputDir:
      request.outputDir === undefined ? undefined : path.resolve(request.cwd, request.outputDir),
  };
  const buildOptions = { ...options, env: createBuildEnvironment(request.mode, options.env) };
  const xcodeSource = await resolveIosSource(request.cwd);
  const exportOptions =
    request.outputType === "ipa"
      ? await readExportOptions(
          path.join(path.dirname(xcodeSource.path), "ExportOptions.plist"),
          request.cwd,
          buildOptions,
        )
      : undefined;
  const schemes = await listSchemes(xcodeSource, request.cwd, buildOptions);
  const scheme = selectScheme(schemes, xcodeSource);
  const configuration: IosBuildConfiguration = request.mode === "development" ? "Debug" : "Release";
  if (exportOptions !== undefined) {
    const buildArgs = createXcodeBuildArgs(
      xcodeSource,
      scheme,
      configuration,
      resolveXcodeDestination(request.destination),
    );
    await validateArchiveBuildSettings(buildArgs, configuration, request, buildOptions);
    return exportIpa(request, xcodeSource, buildArgs, exportOptions, buildOptions);
  }

  const expectedPlatform = resolveBuildPlatform(request.destination);
  return executeIosBuild(
    {
      cwd: request.cwd,
      source: xcodeSource,
      scheme,
      configuration,
      destination: resolveXcodeDestination(request.destination),
      platform: expectedPlatform,
      ...(request.outputDir === undefined ? {} : { outputDir: request.outputDir }),
    },
    buildOptions,
  );
}

function assertDeviceDestination(destination: IosDestination): void {
  if (destination.kind === "simulator") {
    throw new CompileError("IPA export requires a device destination.", { exitCode: 64 });
  }
}

export async function buildIos(
  request: IosBuildRequest,
  options: NativeBuildOptions = {},
): Promise<readonly string[]> {
  return executeIosBuild(request, options);
}

async function executeIosBuild(
  request: IosExecutionRequest,
  options: NativeBuildOptions,
): Promise<readonly string[]> {
  const cwd = path.resolve(request.cwd);
  const source = { ...request.source, path: path.resolve(cwd, request.source.path) };
  const buildArgs = [
    ...createXcodeBuildArgs(source, request.scheme, request.configuration, request.destination),
    ...(request.buildArgs ?? []),
  ];
  const xcodeOutput = await runXcode(
    [...buildArgs, "-showBuildSettings", "-json"],
    cwd,
    "capture",
    options,
  );
  const appPaths = parseBuildAppPaths(xcodeOutput, request.configuration, cwd, request.platform);
  await runXcode(
    [...buildArgs, ...(request.clean ? ["clean"] : []), "build"],
    cwd,
    "stderr",
    options,
  );
  await verifyAppPaths(appPaths);
  for (const appPath of appPaths) {
    await verifyAppExecutable(appPath, cwd, options);
  }
  return copyApps(
    appPaths,
    request.outputDir === undefined ? undefined : path.resolve(cwd, request.outputDir),
    cwd,
    options,
  );
}

async function verifyAppExecutable(
  appPath: string,
  cwd: string,
  options: NativeBuildOptions,
): Promise<void> {
  const output = await runCheckedProcess(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-expect",
      "string",
      "-o",
      "-",
      path.join(appPath, "Info.plist"),
    ],
    { cwd, env: options.env, outputMode: "capture", signal: options.signal },
    "App executable lookup",
    options.runProcess,
  );
  const executable = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (executable === "" || path.basename(executable) !== executable) {
    throw new CompileError(`Xcode produced an invalid CFBundleExecutable in ${appPath}.`);
  }
  const executablePath = path.join(appPath, executable);
  const info = await stat(executablePath).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (info === undefined || !info.isFile() || info.size === 0 || (info.mode & 0o111) === 0) {
    throw new CompileError(
      `Xcode produced ${appPath} without a usable executable. Check the target's architectures and build phases.`,
    );
  }
}

export async function resolveIosSource(cwd: string): Promise<IosSource> {
  const iosDirectories = await inspectIosDirectories(cwd);
  for (const directory of iosDirectories) assertCocoaPodsReady(directory);
  const workspaces = iosDirectories.flatMap((directory) => directory.workspaces);
  if (workspaces.length > 0) {
    return selectSingleSource(workspaces, "workspaces");
  }
  const projects = iosDirectories.flatMap((directory) => directory.projects);
  return selectSingleSource(projects, "projects");
}

export function selectScheme(schemes: readonly string[], xcodeSource: IosSource): string {
  const [onlyScheme] = schemes;
  if (schemes.length === 1 && onlyScheme !== undefined) return onlyScheme;
  if (schemes.length === 0) {
    throw new CompileError(
      "No Xcode schemes found. Share one Xcode scheme before running compile.",
    );
  }
  const sourceName = path.basename(
    xcodeSource.path,
    xcodeSource.kind === "project" ? ".xcodeproj" : ".xcworkspace",
  );
  if (schemes.includes(sourceName)) return sourceName;
  throw new CompileError(
    `Found multiple Xcode schemes and none named "${sourceName}": ${schemes.join(", ")}.`,
  );
}

export async function verifyAppPaths(appPaths: readonly string[]): Promise<void> {
  for (const appPath of appPaths) {
    await assertDirectory(
      appPath,
      `xcodebuild exited with code 0, but ${appPath} is not an app directory.`,
    );
  }
}

async function inspectIosDirectories(cwd: string): Promise<readonly IosDirectory[]> {
  const searchDirectories = [path.resolve(cwd)];
  const iosDirectory = path.resolve(cwd, "ios");
  if (await isDirectory(iosDirectory)) searchDirectories.push(iosDirectory);
  return Promise.all(searchDirectories.map(inspectIosDirectory));
}

async function inspectIosDirectory(directory: string): Promise<IosDirectory> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) =>
      entry.name === "Podfile" ||
      entry.name === "Pods" ||
      entry.name.endsWith(".xcodeproj") ||
      (entry.name.endsWith(".xcworkspace") && entry.name !== "project.xcworkspace"),
  );
  const projects: IosSource[] = [];
  const workspaces: IosSource[] = [];
  let hasPodfile = false;
  let hasPods = false;

  for (const entry of entries) {
    const entryType = entry.isSymbolicLink()
      ? await stat(path.join(directory, entry.name)).catch((error: unknown) => {
          if (isMissingPathError(error)) return undefined;
          throw error;
        })
      : entry;
    if (entryType === undefined) continue;
    if (entry.name === "Podfile") {
      hasPodfile = entryType.isFile();
      continue;
    }
    if (entry.name === "Pods") {
      hasPods = entryType.isDirectory();
      continue;
    }
    if (!entryType.isDirectory()) continue;
    if (entry.name.endsWith(".xcodeproj")) {
      projects.push({
        kind: "project",
        path: path.join(directory, entry.name),
      });
    } else {
      workspaces.push({
        kind: "workspace",
        path: path.join(directory, entry.name),
      });
    }
  }

  return {
    path: directory,
    hasPodfile,
    hasPods,
    projects: sortSources(projects),
    workspaces: sortSources(workspaces),
  };
}

function assertCocoaPodsReady(directory: IosDirectory): void {
  if (!directory.hasPodfile) return;
  if (directory.workspaces.length === 0) {
    throw new CompileError(
      `Found a Podfile in ${directory.path}, but no .xcworkspace. Create the CocoaPods workspace before running compile.`,
    );
  }
  if (!directory.hasPods) {
    throw new CompileError(
      `Found a Podfile in ${directory.path}, but the Pods directory is missing. Install the project's Pods before running compile.`,
    );
  }
}

function selectSingleSource(
  sources: readonly IosSource[],
  sourceKind: "projects" | "workspaces",
): IosSource {
  const [onlySource] = sources;
  if (sources.length === 1 && onlySource !== undefined) return onlySource;
  if (sources.length === 0) {
    throw new CompileError("No Xcode project or workspace found in the current directory or ios/.");
  }
  throw new CompileError(
    `Found multiple Xcode ${sourceKind}:\n${sources.map((source) => `- ${source.path}`).join("\n")}\nCompile requires exactly one ${sourceKind === "projects" ? "project" : "workspace"}.`,
  );
}

function sortSources(sources: IosSource[]): readonly IosSource[] {
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

async function listSchemes(
  xcodeSource: IosSource,
  cwd: string,
  options: NativeBuildOptions,
): Promise<readonly string[]> {
  const xcodeOutput = await runXcode(
    [...xcodeSourceArgs(xcodeSource), "-list", "-json"],
    cwd,
    "capture",
    options,
  );
  return parseSchemes(xcodeOutput);
}

function parseSchemes(xcodeOutput: string): readonly string[] {
  const xcodeData = parseXcodeJson(xcodeOutput, "Xcode scheme list");
  if (!isRecord(xcodeData)) throw invalidXcodeJson("scheme list");
  const schemeContainer = isRecord(xcodeData.project)
    ? xcodeData.project
    : isRecord(xcodeData.workspace)
      ? xcodeData.workspace
      : undefined;
  if (schemeContainer === undefined || !isStringArray(schemeContainer.schemes)) {
    throw invalidXcodeJson("scheme list");
  }
  return schemeContainer.schemes.sort((left, right) => left.localeCompare(right));
}

function createXcodeBuildArgs(
  xcodeSource: IosSource,
  scheme: string,
  configuration: string,
  destination: string,
): readonly string[] {
  return [
    ...xcodeSourceArgs(xcodeSource),
    "-scheme",
    scheme,
    "-configuration",
    configuration,
    "-destination",
    destination,
  ];
}

export function resolveXcodeDestination(destination: IosDestination): string {
  if (destination.kind === "simulator") return "generic/platform=iOS Simulator";
  if (destination.id === undefined) return "generic/platform=iOS";
  return `id=${destination.id}`;
}

function xcodeSourceArgs(xcodeSource: IosSource): readonly string[] {
  return [xcodeSource.kind === "project" ? "-project" : "-workspace", xcodeSource.path];
}

async function validateArchiveBuildSettings(
  buildArgs: readonly string[],
  configuration: IosBuildConfiguration,
  request: IosCompileRequest,
  options: NativeBuildOptions,
): Promise<void> {
  if (request.destination.kind === "device" && request.destination.id !== undefined) {
    const destinationSettings = await runXcode(
      [...buildArgs, "-showBuildSettings", "-json"],
      request.cwd,
      "capture",
      options,
    );
    parseAppPaths(destinationSettings, configuration, request.cwd, { kind: "device" });
  }
  const xcodeOutput = await runXcode(
    [...buildArgs, "archive", "-showBuildSettings", "-json"],
    request.cwd,
    "capture",
    options,
  );
  parseAppPaths(xcodeOutput, configuration, request.cwd, { kind: "device" });
}

export function parseAppPaths(
  xcodeOutput: string,
  configuration: IosBuildConfiguration,
  cwd: string,
  destination: IosDestination,
): readonly string[] {
  return parseBuildAppPaths(xcodeOutput, configuration, cwd, resolveBuildPlatform(destination));
}

function resolveBuildPlatform(destination: IosDestination): IosBuildPlatform | undefined {
  if (destination.kind === "simulator") return "iphonesimulator";
  return destination.id === undefined ? "iphoneos" : undefined;
}

function parseBuildAppPaths(
  xcodeOutput: string,
  configuration: string,
  cwd: string,
  expectedPlatform: IosBuildPlatform | undefined,
): readonly string[] {
  const buildSettingsList = parseXcodeJson(xcodeOutput, "Xcode build settings");
  if (!Array.isArray(buildSettingsList)) {
    throw invalidXcodeJson("build settings");
  }

  const appPaths = new Set<string>();
  for (const targetSettings of buildSettingsList) {
    addAppPath(targetSettings, configuration, cwd, expectedPlatform, appPaths);
  }
  if (appPaths.size === 0) {
    throw new CompileError("The selected scheme has no .app product in Xcode's build settings.");
  }
  return [...appPaths].sort((left, right) => left.localeCompare(right));
}

function addAppPath(
  targetSettings: unknown,
  configuration: string,
  cwd: string,
  expectedPlatform: IosBuildPlatform | undefined,
  appPaths: Set<string>,
): void {
  if (!isRecord(targetSettings) || !isRecord(targetSettings.buildSettings)) return;
  const buildSettings = targetSettings.buildSettings;
  const wrapperName = buildSettings.WRAPPER_NAME;
  if (typeof wrapperName !== "string" || !wrapperName.endsWith(".app")) {
    return;
  }
  if (path.basename(wrapperName) !== wrapperName) {
    throw invalidXcodeJson("WRAPPER_NAME");
  }
  const platform = buildSettings.PLATFORM_NAME;
  if (typeof platform !== "string") throw invalidXcodeJson("PLATFORM_NAME");
  if (!isRelatedBuildPlatform(platform, expectedPlatform ?? "iphoneos")) return;
  assertBuildConfiguration(buildSettings, configuration);
  assertBuildPlatform(platform, expectedPlatform);
  const targetBuildDir = buildSettings.TARGET_BUILD_DIR;
  if (typeof targetBuildDir !== "string") {
    throw invalidXcodeJson("TARGET_BUILD_DIR");
  }
  appPaths.add(path.resolve(cwd, targetBuildDir, wrapperName));
}

function assertBuildConfiguration(
  buildSettings: Record<string, unknown>,
  configuration: string,
): void {
  const resolvedConfiguration = buildSettings.CONFIGURATION;
  if (typeof resolvedConfiguration !== "string") {
    throw invalidXcodeJson("CONFIGURATION");
  }
  if (resolvedConfiguration === configuration) return;
  throw new CompileError(
    `The selected mode requires "${configuration}", but Xcode used "${resolvedConfiguration}". Add a ${configuration} build configuration to the selected project.`,
  );
}

function assertBuildPlatform(
  platform: IosBuildPlatform,
  expectedPlatform: IosBuildPlatform | undefined,
): void {
  if (expectedPlatform === undefined) return;
  if (platform !== expectedPlatform) {
    throw new CompileError(
      `Compile requested ${expectedPlatform}, but Xcode selected ${platform}. Check the selected configuration's supported platforms.`,
    );
  }
}

function isBuildPlatform(platform: string): platform is IosBuildPlatform {
  return Object.hasOwn(platformFamilies, platform);
}

function isRelatedBuildPlatform(
  platform: string,
  expectedPlatform: IosBuildPlatform,
): platform is IosBuildPlatform {
  return (
    isBuildPlatform(platform) && platformFamilies[platform] === platformFamilies[expectedPlatform]
  );
}

export async function copyApps(
  appPaths: readonly string[],
  outputDir: string | undefined,
  cwd: string,
  options: NativeBuildOptions = {},
): Promise<readonly string[]> {
  if (outputDir === undefined) return appPaths;
  const outputPaths = appPaths.map((appPath) => path.join(outputDir, path.basename(appPath)));
  const canonicalOutputDir = await resolveCanonicalPath(outputDir).catch((error: unknown) => {
    throw outputDirectoryError(outputDir, error);
  });
  const sourceApps = await Promise.all(
    appPaths.map(async (sourcePath) => ({
      sourcePath,
      canonicalPath: await realpath(sourcePath),
    })),
  );
  const copies: AppCopy[] = [];
  for (const sourceApp of sourceApps) {
    const outputPath = path.join(outputDir, path.basename(sourceApp.sourcePath));
    const canonicalOutputPath = await resolveCanonicalPath(
      path.join(canonicalOutputDir, path.basename(sourceApp.sourcePath)),
    ).catch((error: unknown) => {
      throw outputDirectoryError(outputDir, error);
    });
    if (sourceApp.canonicalPath === canonicalOutputPath) continue;
    const overlappingSource = sourceApps.find(
      (source) =>
        source.canonicalPath === canonicalOutputPath ||
        isPathInside(source.canonicalPath, canonicalOutputPath) ||
        isPathInside(canonicalOutputPath, source.canonicalPath),
    );
    if (overlappingSource !== undefined) {
      throw new CompileError(
        `Output path ${outputPath} overlaps the source app ${overlappingSource.sourcePath}.`,
      );
    }
    copies.push({ sourcePath: sourceApp.sourcePath, outputPath });
  }

  await createOutputDirectory(outputDir);
  await assertDistinctArtifactNames(appPaths, outputDir);
  for (const copy of copies) await copyApp(copy, cwd, options);
  await verifyAppPaths(outputPaths);
  return outputPaths;
}

async function copyApp(copy: AppCopy, cwd: string, options: NativeBuildOptions): Promise<void> {
  const temporaryDirectory = await createOutputTemporaryDirectory(
    path.dirname(copy.outputPath),
    ".compile-",
  );
  const temporaryPath = path.join(temporaryDirectory, "next.app");
  const backupPath = path.join(temporaryDirectory, "previous.app");
  let keepBackup = false;

  try {
    await runCheckedProcess(
      ditto,
      [copy.sourcePath, temporaryPath],
      { cwd, env: options.env, outputMode: "capture", signal: options.signal },
      "App copy",
      options.runProcess,
    );
    await assertDirectory(
      temporaryPath,
      `App copy created ${temporaryPath}, but it is not an app directory.`,
    );

    const hasPreviousApp = await pathExists(copy.outputPath);
    if (hasPreviousApp) await rename(copy.outputPath, backupPath);
    try {
      await rename(temporaryPath, copy.outputPath);
    } catch (error) {
      if (hasPreviousApp) {
        try {
          await rename(backupPath, copy.outputPath);
        } catch (restoreError) {
          keepBackup = true;
          throw new CompileError(
            `Could not replace ${copy.outputPath}. The previous app remains at ${backupPath}.`,
            { cause: new AggregateError([error, restoreError]) },
          );
        }
      }
      throw new CompileError(`Could not replace ${copy.outputPath}.`, { cause: error });
    }
  } finally {
    if (!keepBackup) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function assertDirectory(directoryPath: string, errorMessage: string): Promise<void> {
  try {
    if ((await stat(directoryPath)).isDirectory()) return;
  } catch (error) {
    throw new CompileError(errorMessage, { cause: error });
  }
  throw new CompileError(errorMessage);
}

async function resolveCanonicalPath(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parentPath = path.dirname(absolutePath);
    if (parentPath === absolutePath) return absolutePath;
    return path.join(await resolveCanonicalPath(parentPath), path.basename(absolutePath));
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function runXcode(
  args: readonly string[],
  cwd: string,
  outputMode: "capture" | "stderr",
  options: NativeBuildOptions,
): Promise<string> {
  return runCheckedProcess(
    xcrun,
    ["xcodebuild", ...args],
    { cwd, env: options.env, outputMode, signal: options.signal },
    "xcodebuild",
    options.runProcess,
  );
}

function parseXcodeJson(output: string, outputName: string): unknown {
  try {
    const xcodeData: unknown = JSON.parse(output);
    return xcodeData;
  } catch (error) {
    throw new CompileError(`${outputName} returned invalid JSON.`, { cause: error });
  }
}

function invalidXcodeJson(fieldName: string): CompileError {
  return new CompileError(`Xcode returned invalid ${fieldName} data.`);
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}
