#!/usr/bin/env node

import { parseCliArgs, usage } from "./args.ts";
import { compileAndroid, compileIos, CompileError } from "./index.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  try {
    const command = parseCliArgs(args, process.cwd());
    if (command.kind === "help") {
      console.log(usage);
      return;
    }
    const { request } = command;
    if (request.platform === "ios" && process.platform !== "darwin") {
      throw new CompileError("Compiling iOS apps requires macOS and Xcode.");
    }
    const outputPaths = await (request.platform === "ios"
      ? compileIos(request)
      : compileAndroid(request));
    for (const outputPath of outputPaths) {
      console.log(`Output: ${outputPath}`);
    }
  } catch (error) {
    handleError(error);
  }
}

function handleError(error: unknown): void {
  if (!(error instanceof CompileError)) {
    const errorText = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`compile: ${errorText}`);
    process.exitCode = 1;
    return;
  }
  console.error(`compile: ${error.message}`);
  if (error.signal !== undefined) process.kill(process.pid, error.signal);
  else process.exitCode = error.exitCode;
}

await main();
