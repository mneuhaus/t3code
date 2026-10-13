// @effect-diagnostics nodeBuiltinImport:off - the flavor and the shared-data owner are read synchronously before the Clerk bridge; an async read yields and lets Electron emit ready before Clerk registers its privileged schemes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Personal build identity that `T3CODE_DESKTOP_FLAVOR` bakes into the packaged
 * package.json (see scripts/build-desktop-artifact.ts). It only changes the
 * app's branding; data, Electron profile and keychain entry stay the release
 * install's, guarded by refuseSharedDataInUse.
 */
export const DesktopFlavor = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u)),
  label: Schema.String,
});
export type DesktopFlavor = typeof DesktopFlavor.Type;

const ServerRuntimeOwner = Schema.Struct({ pid: Schema.Int });
const decodeServerRuntimeOwner = Schema.decodeSync(Schema.fromJsonString(ServerRuntimeOwner));

const PackageFlavorMetadata = Schema.Struct({
  t3codeDesktopFlavor: Schema.optional(DesktopFlavor),
});
const decodePackageFlavorMetadata = Schema.decodeSync(Schema.fromJsonString(PackageFlavorMetadata));

/**
 * A missing package.json or field means the release identity. A malformed
 * field throws so a broken build fails loudly instead of posing as the release.
 */
export function readPackagedDesktopFlavor(input: {
  readonly appPath: string;
  readonly isPackaged: boolean;
}): Option.Option<DesktopFlavor> {
  if (!input.isPackaged) return Option.none();
  let raw: string;
  try {
    raw = NodeFS.readFileSync(NodePath.join(input.appPath, "package.json"), "utf8");
  } catch {
    return Option.none();
  }
  return Option.fromNullishOr(decodePackageFlavorMetadata(raw).t3codeDesktopFlavor);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The pid of a live T3 server that already owns this state directory, from the
 * server-runtime.json it writes while listening. A flavored build shares the
 * release install's data, and neither the release app (no single-instance lock
 * on macOS) nor the server guards that directory, so the flavored app checks
 * before starting a second server on it. A stale or unreadable file is no owner.
 */
export function findLiveServerOwner(
  stateDir: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): number | null {
  let pid: number;
  try {
    pid = decodeServerRuntimeOwner(
      NodeFS.readFileSync(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
    ).pid;
  } catch {
    return null;
  }
  return pid !== process.pid && isAlive(pid) ? pid : null;
}

/**
 * Stops a flavored build while another live server owns the shared data. Built
 * before the Clerk bridge points userData at the shared profile, and like the
 * bridge it must not yield: Electron emits ready, and Chromium opens the
 * profile, as soon as startup yields to the event loop. So it reads
 * synchronously, logs to the console and reports with showErrorBox, which is
 * safe before ready.
 */
export const refuseSharedDataInUse = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.flavor) return;
  const ownerPid = findLiveServerOwner(environment.stateDir);
  if (ownerPid === null) return;

  yield* Effect.logWarning("another T3 Code server owns the shared data; not starting", {
    pid: ownerPid,
    stateDir: environment.stateDir,
  });
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  yield* electronDialog.showErrorBox(
    `${environment.displayName} cannot start`,
    `Another T3 Code app (process ${ownerPid}) is using ${environment.stateDir}. Quit it first, then open ${environment.displayName} again.`,
  );
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.quit;
  return yield* Effect.interrupt;
});

export const layerSharedDataGuard = Layer.effectDiscard(refuseSharedDataInUse);
