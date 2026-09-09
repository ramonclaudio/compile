import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOutputDirectory, createOutputTemporaryDirectory } from "./artifacts.ts";
import { runCheckedProcess } from "./process.ts";
import type { NativeBuildOptions } from "./process.ts";
import { CompileError } from "./types.ts";
import type { IosCompileRequest, IosSource } from "./types.ts";
import { isRecord } from "./validation.ts";

export async function exportIpa(
  request: IosCompileRequest,
  source: IosSource,
  buildArgs: readonly string[],
  exportOptions: Buffer,
  options: NativeBuildOptions,
): Promise<readonly string[]> {
  const nativeDirectory = path.dirname(source.path);
  const outputDir = request.outputDir ?? path.join(nativeDirectory, "build");
  await createOutputDirectory(outputDir);
  const buildDirectory = await createOutputTemporaryDirectory(outputDir, "compile-ios-");
  const archivePath = path.join(buildDirectory, "App.xcarchive");
  const exportPath = path.join(buildDirectory, "export");
  const snapshotPath = path.join(buildDirectory, "ExportOptions.plist");
  await writeFile(snapshotPath, exportOptions, { flag: "wx" });
  const processOptions = {
    cwd: request.cwd,
    env: options.env,
    outputMode: "stderr",
    signal: options.signal,
  } as const;

  await runCheckedProcess(
    "/usr/bin/xcrun",
    ["xcodebuild", ...buildArgs, "-archivePath", archivePath, "archive"],
    processOptions,
    `xcodebuild archive (${archivePath})`,
    options.runProcess,
  );
  await runCheckedProcess(
    "/usr/bin/xcrun",
    [
      "xcodebuild",
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      exportPath,
      "-exportOptionsPlist",
      snapshotPath,
    ],
    processOptions,
    `IPA export (${buildDirectory})`,
    options.runProcess,
  );
  const ipaPaths = await findIpas(exportPath);
  if (ipaPaths.length === 0) {
    throw new CompileError(
      `Xcode exported no IPA files to ${exportPath}. The archive remains at ${archivePath}.`,
    );
  }
  return ipaPaths;
}

export async function readExportOptions(
  optionsPath: string,
  cwd: string,
  options: NativeBuildOptions,
): Promise<Buffer> {
  const contents = await readFile(optionsPath).catch((error: unknown) => {
    throw new CompileError(
      `IPA export requires Apple's ExportOptions.plist beside the selected Xcode project or workspace: ${optionsPath}.`,
      { cause: error },
    );
  });
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "compile-export-options-"));
  try {
    const snapshotPath = path.join(temporaryDirectory, "ExportOptions.plist");
    await writeFile(snapshotPath, contents);
    const json = await runCheckedProcess(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", snapshotPath],
      { cwd, env: options.env, outputMode: "capture", signal: options.signal },
      `Export options validation (${optionsPath})`,
      options.runProcess,
    );
    const exportOptions: unknown = JSON.parse(json);
    validateExportOptions(exportOptions);
    return contents;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function validateExportOptions(options: unknown): void {
  if (!isRecord(options)) {
    throw new CompileError("ExportOptions.plist must contain a dictionary.");
  }
  if ("destination" in options && options.destination !== "export") {
    throw new CompileError(
      'Compile exports local IPA files. Set destination to "export" in ExportOptions.plist.',
    );
  }
  const methods = [
    "debugging",
    "release-testing",
    "enterprise",
    "app-store-connect",
    "development",
    "ad-hoc",
    "app-store",
  ];
  if (
    !("method" in options) ||
    typeof options.method !== "string" ||
    !methods.includes(options.method)
  ) {
    throw new CompileError(
      "Set an iOS distribution method in ExportOptions.plist: debugging, release-testing, enterprise, or app-store-connect. Legacy aliases development, ad-hoc, and app-store are also accepted.",
    );
  }
}

export async function findIpas(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const ipaPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ipa")) continue;
    const entryPath = path.join(entry.parentPath, entry.name);
    if ((await stat(entryPath)).size === 0) {
      throw new CompileError(`Xcode exported an empty IPA file: ${entryPath}.`);
    }
    ipaPaths.push(entryPath);
  }
  return ipaPaths.sort((left, right) => left.localeCompare(right));
}
