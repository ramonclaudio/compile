import { createReadStream, createWriteStream, mkdtempSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ProcessLogResult {
  readonly logFilePath?: string;
  readonly logError?: string;
}

interface OutputStreamLog {
  readonly filePath: string;
  readonly writer: WriteStream;
  readonly closed: Promise<void>;
}

export class ProcessLog {
  truncated = false;
  private readonly directory: string | undefined;
  private readonly streams: Partial<Record<"stdout" | "stderr", OutputStreamLog>> = {};
  private error: Error | undefined;

  constructor() {
    try {
      this.directory = mkdtempSync(path.join(os.tmpdir(), "compile-output-"));
      for (const name of ["stdout", "stderr"] as const) {
        const filePath = path.join(this.directory, name === "stdout" ? "native.log" : "stderr.log");
        const writer = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
        const closed = new Promise<void>((resolve) => {
          writer.once("close", resolve);
        });
        this.streams[name] = { filePath, writer, closed };
        writer.on("error", (error: Error) => {
          this.recordError(error);
        });
      }
    } catch (error) {
      this.recordError(error);
    }
  }

  capture(stream: Readable, name: "stdout" | "stderr"): void {
    const writer = this.streams[name]?.writer;
    if (writer === undefined || writer.destroyed) return;
    stream.pipe(writer, { end: false });
    writer.once("error", () => {
      stream.unpipe(writer);
      stream.resume();
    });
  }

  async finish(failed: boolean): Promise<ProcessLogResult> {
    const streams = Object.values(this.streams);
    for (const stream of streams) stream.writer.end();
    await Promise.all(streams.map((stream) => stream.closed));
    const retain = failed && this.truncated;
    if (retain) {
      const saved = await this.save();
      if (saved !== undefined) return saved;
    }
    await this.remove();
    return retain && this.error !== undefined ? { logError: this.error.message } : {};
  }

  private async save(): Promise<ProcessLogResult | undefined> {
    const { stdout, stderr } = this.streams;
    if (this.error !== undefined || stdout === undefined || stderr === undefined) return undefined;
    try {
      await appendStderr(stdout, stderr);
      await rm(stderr.filePath, { force: true });
      return { logFilePath: stdout.filePath };
    } catch (error) {
      this.recordError(error);
      return undefined;
    }
  }

  private async remove(): Promise<void> {
    if (this.directory !== undefined) {
      try {
        await rm(this.directory, { recursive: true, force: true });
      } catch (error) {
        this.recordError(error);
      }
    }
  }

  private recordError(error: unknown): void {
    this.error ??=
      error instanceof Error ? error : new Error("Native output log failed.", { cause: error });
  }
}

async function appendStderr(stdout: OutputStreamLog, stderr: OutputStreamLog): Promise<void> {
  if (stderr.writer.bytesWritten === 0) return;
  async function* chunks(): AsyncGenerator<Buffer> {
    if (stdout.writer.bytesWritten > 0) yield Buffer.from("\n");
    yield* createReadStream(stderr.filePath);
  }
  await pipeline(
    Readable.from(chunks(), { objectMode: false }),
    createWriteStream(stdout.filePath, { flags: "a" }),
  );
}
