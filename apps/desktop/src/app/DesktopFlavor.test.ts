// @effect-diagnostics nodeBuiltinImport:off - the test writes a packaged package.json fixture to disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { findLiveServerOwner, readPackagedDesktopFlavor } from "./DesktopFlavor.ts";

function appPathWithPackageJson(packageJson: unknown): string {
  const appPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-flavor-"));
  NodeFS.writeFileSync(NodePath.join(appPath, "package.json"), JSON.stringify(packageJson));
  return appPath;
}

describe("readPackagedDesktopFlavor", () => {
  it("reads the flavor a flavored build recorded in its package.json", () => {
    const appPath = appPathWithPackageJson({
      name: "t3code",
      t3codeDesktopFlavor: { id: "marc", label: "Marc" },
    });
    assert.deepEqual(
      readPackagedDesktopFlavor({ appPath, isPackaged: true }),
      Option.some({ id: "marc", label: "Marc" }),
    );
    // Unpackaged runs never take a flavor, even from a stray field.
    assert.deepEqual(readPackagedDesktopFlavor({ appPath, isPackaged: false }), Option.none());
  });

  it("keeps the release identity without the field or the file", () => {
    assert.deepEqual(
      readPackagedDesktopFlavor({
        appPath: appPathWithPackageJson({ name: "t3code" }),
        isPackaged: true,
      }),
      Option.none(),
    );
    assert.deepEqual(
      readPackagedDesktopFlavor({
        appPath: NodePath.join(NodeOS.tmpdir(), "t3-flavor-missing"),
        isPackaged: true,
      }),
      Option.none(),
    );
  });

  it("refuses a malformed flavor instead of falling back to the release data", () => {
    const appPath = appPathWithPackageJson({ t3codeDesktopFlavor: { id: "Not Valid" } });
    assert.throws(() => readPackagedDesktopFlavor({ appPath, isPackaged: true }));
  });
});

describe("findLiveServerOwner", () => {
  function stateDirWithRuntime(runtime: unknown): string {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-"));
    NodeFS.writeFileSync(NodePath.join(stateDir, "server-runtime.json"), JSON.stringify(runtime));
    return stateDir;
  }
  const runtime = { version: 1, pid: 4242, host: "127.0.0.1", port: 3773 };

  it("reports a live server that owns the state directory", () => {
    assert.equal(
      findLiveServerOwner(stateDirWithRuntime(runtime), (pid) => pid === 4242),
      4242,
    );
  });

  it("ignores a stale, missing or unreadable runtime file", () => {
    assert.equal(
      findLiveServerOwner(stateDirWithRuntime(runtime), () => false),
      null,
    );
    assert.equal(
      findLiveServerOwner(NodePath.join(NodeOS.tmpdir(), "t3-runtime-missing"), () => true),
      null,
    );
    assert.equal(
      findLiveServerOwner(stateDirWithRuntime({ pid: "x" }), () => true),
      null,
    );
  });

  it("does not count its own process as another owner", () => {
    assert.equal(
      findLiveServerOwner(stateDirWithRuntime({ ...runtime, pid: process.pid }), () => true),
      null,
    );
  });
});
