import { parseArgs } from "node:util";

import { CompileError } from "./types.ts";
import type {
  AndroidOutputType,
  BuildMode,
  CompileRequest,
  IosDestination,
  IosOutputType,
} from "./types.ts";

const cliOptions = {
  dev: { type: "boolean" },
  development: { type: "boolean" },
  prod: { type: "boolean" },
  production: { type: "boolean" },
  device: { type: "string" },
  "output-type": { type: "string" },
  "output-dir": { type: "string" },
  help: { type: "boolean" },
} as const;

type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "compile"; readonly request: CompileRequest };

type ParsedArguments = ReturnType<typeof parseArguments>;

export const usage = `Usage:
  compile ios (--dev | --prod) [options]
  compile android (--dev | --prod) [options]

Options:
  --dev, --development       Build in development mode
  --prod, --production       Build in production mode
  --device [id]              Build for a generic or specific iOS device
  --output-type <type>       iOS: app or ipa. Android: apk or aab
  --output-dir <path>        Write output files to this directory
  --help                     Show help`;

export function parseCliArgs(args: readonly string[], cwd: string): CliCommand {
  const parsedArgs = parseArguments(args);
  if (parsedArgs.values.help) {
    return { kind: "help" };
  }
  return {
    kind: "compile",
    request: createCompileRequest(parsedArgs, cwd),
  };
}

function parseArguments(args: readonly string[]) {
  try {
    return parseArgs({
      args: normalizeDeviceOptions(args),
      options: cliOptions,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CompileError(message, { exitCode: 64, cause: error });
  }
}

function normalizeDeviceOptions(args: readonly string[]): readonly string[] {
  const normalizedArgs = [...args];
  for (const [index, arg] of args.entries()) {
    if (arg === "--") break;
    if (arg !== "--device") continue;
    const nextArg = args[index + 1];
    if (nextArg === undefined || nextArg.startsWith("--")) {
      normalizedArgs[index] = "--device=generic";
    }
  }
  return normalizedArgs;
}

function resolvePlatform(positionals: readonly string[]): CompileRequest["platform"] {
  const [platform, extra] = positionals;
  if (platform !== "ios" && platform !== "android") {
    const receivedPlatform = platform === undefined ? "no platform" : `"${platform}"`;
    throw new CompileError(`Platform must be "ios" or "android". Got ${receivedPlatform}.`, {
      exitCode: 64,
    });
  }
  if (extra !== undefined) {
    throw new CompileError(`Unexpected argument "${extra}".`, { exitCode: 64 });
  }
  return platform;
}

function resolveMode(modeFlags: ParsedArguments["values"]): BuildMode {
  const development = Boolean(modeFlags.dev || modeFlags.development);
  const production = Boolean(modeFlags.prod || modeFlags.production);
  if (development === production) {
    throw new CompileError("Choose exactly one mode: --dev or --prod.", { exitCode: 64 });
  }
  return development ? "development" : "production";
}

function resolveDestination(deviceId: string | undefined): IosDestination {
  if (deviceId === undefined) return { kind: "simulator" };
  if (deviceId === "generic") return { kind: "device" };
  if (!/^[A-Za-z0-9-]+$/.test(deviceId)) {
    throw new CompileError("Device ID must contain only letters, numbers, and hyphens.", {
      exitCode: 64,
    });
  }
  return { kind: "device", id: deviceId };
}

function createCompileRequest(
  { positionals, values }: ParsedArguments,
  cwd: string,
): CompileRequest {
  const platform = resolvePlatform(positionals);
  const mode = resolveMode(values);
  const outputDir = values["output-dir"];
  const deviceId = values.device;

  if (platform === "ios") {
    const outputType = resolveIosOutputType(values["output-type"]);
    const destination = resolveDestination(deviceId);
    if (outputType === "ipa") {
      if (destination.kind === "simulator") {
        throw new CompileError(
          "IPA export requires --device. Simulator apps use --output-type app.",
          { exitCode: 64 },
        );
      }
      return { platform, cwd, mode, outputType, destination, outputDir };
    }
    return {
      platform,
      cwd,
      mode,
      outputType,
      destination,
      outputDir,
    };
  }
  if (deviceId !== undefined) {
    throw new CompileError(
      "Android builds do not use --device. APK and AAB builds do not target a connected device.",
      { exitCode: 64 },
    );
  }
  return {
    platform,
    cwd,
    mode,
    outputType: resolveAndroidOutputType(values["output-type"]),
    outputDir,
  };
}

function resolveIosOutputType(outputType = "app"): IosOutputType {
  if (outputType === "app" || outputType === "ipa") return outputType;
  throw new CompileError(
    `The iOS command supports output types "app" and "ipa". Got "${outputType}".`,
    { exitCode: 64 },
  );
}

function resolveAndroidOutputType(outputType = "apk"): AndroidOutputType {
  if (outputType === "apk" || outputType === "aab") return outputType;
  throw new CompileError(
    `The Android command supports output types "apk" and "aab". Got "${outputType}".`,
    { exitCode: 64 },
  );
}
