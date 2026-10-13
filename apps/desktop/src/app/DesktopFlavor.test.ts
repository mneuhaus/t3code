// @effect-diagnostics nodeBuiltinImport:off - the test writes a packaged package.json fixture to disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  type DesktopFlavor,
  findLiveServerOwner,
  readPackagedDesktopFlavor,
  refuseSharedDataInUse,
} from "./DesktopFlavor.ts";

function appPathWithPackageJson(packageJson: unknown): string {
  const appPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-flavor-"));
  NodeFS.writeFileSync(NodePath.join(appPath, "package.json"), JSON.stringify(packageJson));
  return appPath;
}

function stateDirWithRuntime(runtime: unknown): string {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-"));
  NodeFS.writeFileSync(NodePath.join(stateDir, "server-runtime.json"), JSON.stringify(runtime));
  return stateDir;
}
const runtime = { version: 1, pid: 4242, host: "127.0.0.1", port: 3773 };

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

describe("refuseSharedDataInUse", () => {
  const marc: DesktopFlavor = { id: "marc", label: "Marc" };

  const runGuard = Effect.fn(function* (input: {
    readonly flavor: DesktopFlavor | undefined;
    readonly stateDir: string;
  }) {
    const events: string[] = [];
    const services = Layer.mergeAll(
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        flavor: input.flavor,
        stateDir: input.stateDir,
        displayName: "T3 Code (Marc)",
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      Layer.succeed(ElectronDialog.ElectronDialog, {
        showErrorBox: (title: string) => Effect.sync(() => events.push(`errorBox:${title}`)),
      } as unknown as ElectronDialog.ElectronDialog["Service"]),
      Layer.succeed(ElectronApp.ElectronApp, {
        quit: Effect.sync(() => events.push("quit")),
      } as unknown as ElectronApp.ElectronApp["Service"]),
    );
    const exit = yield* Effect.exit(refuseSharedDataInUse.pipe(Effect.provide(services)));
    return { exit, events };
  });

  it.effect("stops a flavored build while a live server owns the shared data", () =>
    Effect.gen(function* () {
      // The test runner's parent process stands in for the running release app.
      const { exit, events } = yield* runGuard({
        flavor: marc,
        stateDir: stateDirWithRuntime({ ...runtime, pid: process.ppid }),
      });
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual(events, ["errorBox:T3 Code (Marc) cannot start", "quit"]);
    }),
  );

  it.effect("lets a flavored build start when no live server owns the data", () =>
    Effect.gen(function* () {
      const { exit, events } = yield* runGuard({
        flavor: marc,
        stateDir: NodePath.join(NodeOS.tmpdir(), "t3-runtime-missing"),
      });
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepEqual(events, []);
    }),
  );

  it.effect("never stops the release build", () =>
    Effect.gen(function* () {
      const { exit, events } = yield* runGuard({
        flavor: undefined,
        stateDir: stateDirWithRuntime({ ...runtime, pid: process.ppid }),
      });
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepEqual(events, []);
    }),
  );
});
