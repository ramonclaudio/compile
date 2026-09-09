import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CompileError } from "./types.ts";

export async function createOutputDirectory(outputDir: string): Promise<void> {
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (error) {
    throw outputDirectoryError(outputDir, error);
  }
}

export async function createOutputTemporaryDirectory(
  outputDir: string,
  prefix: string,
): Promise<string> {
  try {
    return await mkdtemp(path.join(outputDir, prefix));
  } catch (error) {
    throw outputDirectoryError(outputDir, error);
  }
}

export function outputDirectoryError(outputDir: string, error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error), { cause: error });
  if (!("syscall" in error)) return error;
  return new CompileError(
    `Could not use output directory ${outputDir}: ${error.message}. Choose a writable directory.`,
    { cause: error },
  );
}

export async function assertDistinctArtifactNames(
  artifactPaths: readonly string[],
  outputDir: string,
): Promise<void> {
  if (artifactPaths.length < 2) return;
  const temporaryDirectory = await createOutputTemporaryDirectory(outputDir, ".compile-names-");
  try {
    for (const artifactPath of artifactPaths) {
      await writeFile(path.join(temporaryDirectory, path.basename(artifactPath)), "", {
        flag: "wx",
      });
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CompileError(
        `More than one artifact would be copied to the same path in ${outputDir}.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
