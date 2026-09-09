import { cp } from "node:fs/promises";
import path from "node:path";

const generatedDirectories = new Set([
  "build",
  ".build",
  ".gradle",
  "out",
  "node_modules",
  "xcuserdata",
  "DerivedData",
]);

export async function copyFixture(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return (
        !generatedDirectories.has(name) &&
        !/\.(?:app|ipa|apk|aab|xcarchive|xcresult|dSYM)$/.test(name)
      );
    },
  });
}
