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
 * The pid of a live T3 server that owns this state directory, from the
 * server-runtime.json it writes while listening. A stale or unreadable file is no owner.
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
  // Signal 0 to pid 0 or a negative pid probes a process group, not one owner.
  return pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
}

/**
 * Stops a flavored build, naming the process to quit, while another live server owns
 * the shared data. Runs before Clerk opens the shared profile and must not yield, or
 * Electron emits ready first; showErrorBox is safe before ready.
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
