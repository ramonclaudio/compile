export type BuildMode = "development" | "production";
export type IosOutputType = "app" | "ipa";
export type AndroidOutputType = "apk" | "aab";
export type IosBuildPlatform =
  | "iphoneos"
  | "iphonesimulator"
  | "appletvos"
  | "appletvsimulator"
  | "watchos"
  | "watchsimulator"
  | "xros"
  | "xrsimulator";
export type IosDestination =
  | { readonly kind: "simulator" }
  | { readonly kind: "device"; readonly id?: string };

export type IosSource =
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "workspace"; readonly path: string };

export type IosCompileRequest = {
  readonly platform: "ios";
  readonly cwd: string;
  readonly mode: BuildMode;
  readonly outputDir: string | undefined;
} & (
  | { readonly outputType: "app"; readonly destination: IosDestination }
  | {
      readonly outputType: "ipa";
      readonly destination: Extract<IosDestination, { kind: "device" }>;
    }
);

export interface AndroidCompileRequest {
  readonly platform: "android";
  readonly cwd: string;
  readonly mode: BuildMode;
  readonly outputType: AndroidOutputType;
  readonly outputDir: string | undefined;
}

export type CompileRequest = AndroidCompileRequest | IosCompileRequest;

interface CompileErrorOptions {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly cause?: unknown;
}

export class CompileError extends Error {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | undefined;

  constructor(message: string, { exitCode = 1, signal, cause }: CompileErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompileError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}
