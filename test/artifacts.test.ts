import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { copyAndroidArtifacts } from "../src/android.ts";
import { assertDistinctArtifactNames } from "../src/artifacts.ts";
import { exportIpa } from "../src/ios-export.ts";
import { copyApps } from "../src/ios.ts";
import { CompileError } from "../src/types.ts";

const isWindows = process.platform === "win32";
const isMacOS = process.platform === "darwin";

for (const artifactPaths of [[], ["App.apk"]] as const) {
  void test(`does not touch the output directory for ${artifactPaths.length} artifact names`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-names-"));
    context.after(() => rm(root, { recursive: true, force: true }));

    await assertDistinctArtifactNames(artifactPaths, path.join(root, "missing"));

    assert.deepEqual(await readdir(root), []);
  });
}

void test("checks distinct names without changing existing output files", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "compile-names-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));
  const output = path.join(outputDir, "App.apk");
  await writeFile(output, "existing artifact");

  await assertDistinctArtifactNames(["first/App.apk", "second/Other.apk"], outputDir);

  assert.equal(await readFile(output, "utf8"), "existing artifact");
  assert.deepEqual(await readdir(outputDir), ["App.apk"]);
});

void test("preserves the filesystem cause and removes temporary files when names collide", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "compile-names-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));

  await assert.rejects(
    assertDistinctArtifactNames(["first/App.apk", "second/App.apk"], outputDir),
    (error: unknown) => {
      assert(error instanceof CompileError);
      assert.equal(error.exitCode, 1);
      assert(error.cause instanceof Error && "code" in error.cause);
      assert.equal(error.cause.code, "EEXIST");
      return true;
    },
  );

  assert.deepEqual(await readdir(outputDir), []);
});

void test("explains temporary directory creation errors and preserves their cause", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compile-names-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    assertDistinctArtifactNames(["App.apk", "Other.apk"], path.join(root, "missing")),
    (error: unknown) => {
      assert(error instanceof CompileError);
      assert.match(error.message, /Could not use output directory/);
      assert(error.cause instanceof Error && "code" in error.cause);
      assert.equal(error.cause.code, "ENOENT");
      return true;
    },
  );

  assert.deepEqual(await readdir(root), []);
});

for (const operation of ["names", "app", "ipa"] as const) {
  void test(
    `explains a read-only output directory during ${operation} preparation`,
    { skip: isWindows || process.getuid?.() === 0 },
    async (context) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "compile-readonly-output-"));
      const outputDir = path.join(root, "output");
      await mkdir(outputDir);
      context.after(async () => {
        await chmod(outputDir, 0o755);
        await rm(root, { recursive: true, force: true });
      });
      const source = path.join(root, "App.app");
      await mkdir(source);
      await writeFile(path.join(source, "marker"), "keep this source");
      await writeFile(path.join(outputDir, "marker"), "keep this output");
      await chmod(outputDir, 0o555);

      const prepare = () => {
        if (operation === "names") {
          return assertDistinctArtifactNames(["first.apk", "second.apk"], outputDir);
        }
        if (operation === "app") return copyApps([source], outputDir, root);
        return exportIpa(
          {
            platform: "ios",
            cwd: root,
            mode: "production",
            outputType: "ipa",
            outputDir,
            destination: { kind: "device" },
          },
          { kind: "project", path: path.join(root, "App.xcodeproj") },
          [],
          Buffer.from("options"),
          {
            runProcess: () => {
              throw new Error("Must not invoke Xcode");
            },
          },
        );
      };
      await assert.rejects(prepare(), (error: unknown) => {
        assert(error instanceof CompileError);
        assert.match(error.message, /Could not use output directory/);
        assert.ok(error.message.includes(outputDir));
        assert(error.cause instanceof Error && "code" in error.cause);
        assert.equal(error.cause.code, "EACCES");
        return true;
      });
      assert.equal(await readFile(path.join(source, "marker"), "utf8"), "keep this source");
      assert.equal(await readFile(path.join(outputDir, "marker"), "utf8"), "keep this output");
      assert.deepEqual(await readdir(outputDir), ["marker"]);
    },
  );
}

void test("preserves other write errors and removes temporary files", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "compile-names-"));
  context.after(() => rm(outputDir, { recursive: true, force: true }));

  await assert.rejects(assertDistinctArtifactNames(["App.apk", "invalid\u0000.apk"], outputDir), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_VALUE",
  });

  assert.deepEqual(await readdir(outputDir), []);
});

for (const outputType of ["apk", "app"] as const) {
  for (const [firstName, secondName] of [
    ["App", "App"],
    ["App", "app"],
    ["Café", "Cafe\u0301"],
  ] as const) {
    void test(
      `preserves ${outputType} files when output names collide: ${firstName}, ${secondName}`,
      { skip: outputType === "app" && process.platform !== "darwin" },
      async (context) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "compile-copy-names-"));
        context.after(() => rm(root, { recursive: true, force: true }));
        const outputDir = path.join(root, "output");
        const first = path.join(root, "first", `${firstName}.${outputType}`);
        const second = path.join(root, "second", `${secondName}.${outputType}`);
        const output = path.join(outputDir, `${firstName}.${outputType}`);
        const otherOutput = path.join(outputDir, `${secondName}.${outputType}`);
        const markerPath = (artifactPath: string) =>
          outputType === "app" ? path.join(artifactPath, "marker.txt") : artifactPath;
        for (const [artifactPath, contents] of [
          [first, "first artifact"],
          [second, "second artifact"],
          [output, "existing artifact"],
        ] as const) {
          const marker = markerPath(artifactPath);
          await mkdir(path.dirname(marker), { recursive: true });
          await writeFile(marker, contents);
        }
        const existingNames = await readdir(outputDir);
        const namesCollide = await access(otherOutput).then(
          () => true,
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          },
        );
        const copy = () =>
          outputType === "app"
            ? copyApps([first, second], outputDir, root)
            : copyAndroidArtifacts([first, second], outputDir, outputType);

        if (namesCollide) {
          await assert.rejects(copy(), /same path/);
          assert.equal(await readFile(markerPath(output), "utf8"), "existing artifact");
          assert.deepEqual(await readdir(outputDir), existingNames);
        } else {
          assert.deepEqual(await copy(), [output, otherOutput]);
          assert.equal(await readFile(markerPath(output), "utf8"), "first artifact");
          assert.equal(await readFile(markerPath(otherOutput), "utf8"), "second artifact");
          assert.equal((await readdir(outputDir)).length, 2);
        }
        assert.equal(await readFile(markerPath(first), "utf8"), "first artifact");
        assert.equal(await readFile(markerPath(second), "utf8"), "second artifact");
      },
    );
  }
}

void test(
  "rejects an Android output that would overwrite another source through a symlink",
  { skip: isWindows },
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "compile-artifacts-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const sourceDir = path.join(root, "source");
    const outputDir = path.join(root, "output");
    await mkdir(sourceDir);
    await mkdir(outputDir);
    const first = path.join(sourceDir, "first.apk");
    const second = path.join(sourceDir, "second.apk");
    const previousOutput = path.join(outputDir, "second.apk");
    await writeFile(previousOutput, "first artifact");
    await symlink(previousOutput, first);
    await writeFile(second, "second artifact");

    await assert.rejects(copyAndroidArtifacts([first, second], outputDir, "apk"), /overlap/);
    assert.equal(await readFile(first, "utf8"), "first artifact");
    assert.equal(await readFile(second, "utf8"), "second artifact");
    assert.deepEqual(await readdir(outputDir), ["second.apk"]);
  },
);

for (const name of ["previous.app", "Previous.app"]) {
  void test(
    `replaces ${name} without colliding with its backup`,
    { skip: !isMacOS },
    async (context) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "compile-artifacts-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const source = path.join(root, "source", name);
      const outputDir = path.join(root, "output");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "marker.txt"), "first version");
      await copyApps([source], outputDir, root);
      await writeFile(path.join(source, "marker.txt"), "second version");

      assert.deepEqual(await copyApps([source], outputDir, root), [path.join(outputDir, name)]);
      assert.equal(
        await readFile(path.join(outputDir, name, "marker.txt"), "utf8"),
        "second version",
      );
      assert.deepEqual(await readdir(outputDir), [name]);
    },
  );
}

void test("copies an Android artifact whose filename is 240 bytes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compile-artifacts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const name = `${"a".repeat(236)}.apk`;
  const source = path.join(root, "source", name);
  const outputDir = path.join(root, "output");
  await mkdir(path.dirname(source));
  await writeFile(source, "artifact");

  assert.deepEqual(await copyAndroidArtifacts([source], outputDir, "apk"), [
    path.join(outputDir, name),
  ]);
  assert.equal(await readFile(path.join(outputDir, name), "utf8"), "artifact");
  assert.deepEqual(await readdir(outputDir), [name]);
});

void test(
  "rejects a case-equivalent output that would replace a later Android source",
  { skip: isWindows },
  async (context) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "compile-source-case-")));
    context.after(() => rm(root, { recursive: true, force: true }));
    const sourceDir = path.join(root, "source");
    const outputDir = path.join(root, "output");
    await mkdir(sourceDir);
    await mkdir(outputDir);
    const first = path.join(sourceDir, "app.apk");
    const alias = path.join(sourceDir, "alias.apk");
    const existingSource = path.join(outputDir, "App.apk");
    await writeFile(first, "first APK");
    await writeFile(existingSource, "second APK");
    await symlink(existingSource, alias);
    const lowercaseOutput = await realpath(path.join(outputDir, "app.apk")).catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (lowercaseOutput === undefined) {
      context.skip("Requires a filesystem that treats App.apk and app.apk as the same file.");
      return;
    }
    assert.equal(lowercaseOutput, existingSource);

    await assert.rejects(copyAndroidArtifacts([first, alias], outputDir, "apk"), /overlap/);
    assert.equal(await readFile(first, "utf8"), "first APK");
    assert.equal(await readFile(alias, "utf8"), "second APK");
    assert.equal(await readFile(existingSource, "utf8"), "second APK");
    assert.deepEqual(await readdir(outputDir), ["App.apk"]);
  },
);

for (const outputType of ["apk", "aab", "app", "ipa"] as const) {
  for (const nested of [false, true]) {
    void test(`reports a file blocking the ${outputType} output directory (nested: ${nested})`, async (context) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "compile-output-directory-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const blocker = path.join(root, "output");
      const outputDir = nested ? path.join(blocker, "nested") : blocker;
      const source = path.join(root, `App.${outputType}`);
      await writeFile(blocker, "keep this file");
      const marker = outputType === "app" ? path.join(source, "marker") : source;
      if (outputType === "app") await mkdir(source);
      await writeFile(marker, "keep this artifact");
      const copy = () => {
        if (outputType === "app") return copyApps([source], outputDir, root);
        if (outputType === "ipa")
          return exportIpa(
            {
              platform: "ios",
              cwd: root,
              mode: "production",
              outputType,
              outputDir,
              destination: { kind: "device" },
            },
            { kind: "project", path: path.join(root, "App.xcodeproj") },
            [],
            Buffer.from("options"),
            {
              runProcess: () => {
                throw new Error("Must not invoke Xcode");
              },
            },
          );
        return copyAndroidArtifacts([source], outputDir, outputType);
      };
      await assert.rejects(copy(), (error: unknown) => {
        assert(error instanceof CompileError);
        assert.match(error.message, /Could not use output directory/);
        assert.ok(error.message.includes(outputDir));
        assert(error.cause instanceof Error && "code" in error.cause);
        assert.ok(error.cause.code === "EEXIST" || error.cause.code === "ENOTDIR");
        return true;
      });
      assert.equal(await readFile(blocker, "utf8"), "keep this file");
      assert.equal(await readFile(marker, "utf8"), "keep this artifact");
    });
  }
}
