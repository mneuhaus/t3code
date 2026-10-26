// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery, scoreDirectoryMatch } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly listIgnoredFiles: (
      input: ProjectListIgnoredFilesInput,
    ) => Effect.Effect<ProjectListIgnoredFilesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceEntries") {}

/** Ignored files offered for copying; more than this is a build folder, not config. */
const IGNORED_FILES_LIMIT = 200;

/** Paths sent to one `git check-ignore` call when labelling a folder's children. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = Effect.fn("WorkspaceEntries.recoverRefreshFailure")(
          function* (
            cause:
              | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
              | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
              | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
          ) {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          },
        );
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const readBrowseDirectory = Effect.fn("WorkspaceEntries.readBrowseDirectory")(function* (
    parentPath: string,
    input: FilesystemBrowseInput,
  ) {
    return yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
      catch: (cause) =>
        new WorkspaceEntriesReadDirectoryError({
          cwd: input.cwd,
          partialPath: input.partialPath,
          parentPath,
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        (error) => {
          const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
          return code === "EACCES" || code === "EPERM";
        },
        () => Effect.succeed([]),
      ),
    );
  });

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const home = yield* HostProcess.HomeDirectory;
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);
      const searchRoot =
        input.partialPath.startsWith("~/") || input.partialPath === "~"
          ? path.resolve(expandHomePath("~", home))
          : isExplicitRelativePath(input.partialPath) && input.cwd
            ? path.resolve(
                expandHomePath(input.cwd, home),
                input.partialPath.match(/^(?:\.\.?[\\/])+/)?.[0] ?? ".",
              )
            : path.parse(parentPath).root;
      let anchorPath = parentPath;
      const missingSegments: string[] = [];
      let remainingReads = 128;
      const listings = new Map<string, ReadonlyArray<NodeFS.Dirent> | undefined>();
      const loadDirectory = Effect.fn(function* (directoryPath: string) {
        if (listings.has(directoryPath)) return listings.get(directoryPath);
        if (remainingReads <= 0) return undefined;
        remainingReads -= 1;
        const dirents = yield* readBrowseDirectory(directoryPath, input).pipe(
          Effect.catchIf(
            (error) => {
              const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
              return input.fuzzy === true && (code === "ENOENT" || code === "ENOTDIR");
            },
            () => Effect.succeed(undefined),
          ),
        );
        listings.set(directoryPath, dirents);
        return dirents;
      });

      // An existing abbreviation can be a dead end ("wor/mak" when "wor" is
      // empty but "Workspace/makespace" exists). Widen the anchor until the
      // whole query matches, retaining the one-listing path for exact hits.
      // Listings are reused when widening; work stays bounded along typed paths.
      while (true) {
        const dirents = yield* loadDirectory(anchorPath);
        let directories =
          dirents === undefined ? [] : [{ fullPath: anchorPath, dirents, score: 0 }];
        for (const segment of missingSegments) {
          const candidates = directories
            .flatMap((directory) =>
              directory.dirents.flatMap((entry) => {
                if (
                  !entry.isDirectory() ||
                  (entry.name.startsWith(".") && !segment.startsWith("."))
                )
                  return [];
                const score = scoreDirectoryMatch(entry.name, segment);
                return score === null
                  ? []
                  : [
                      {
                        fullPath: path.join(directory.fullPath, entry.name),
                        score: directory.score + score,
                      },
                    ];
              }),
            )
            .sort(
              (left, right) =>
                left.score - right.score || left.fullPath.localeCompare(right.fullPath),
            )
            .slice(0, 20);
          const results = yield* Effect.forEach(
            candidates,
            Effect.fn(function* (candidate) {
              const children = yield* loadDirectory(candidate.fullPath).pipe(
                Effect.orElseSucceed(() => undefined),
              );
              return children === undefined ? [] : [{ ...candidate, dirents: children }];
            }),
            { concurrency: 4 },
          );
          directories = results.flat();
          if (directories.length === 0) break;
        }

        const showHidden = endsWithSeparator || prefix.startsWith(".");
        const lowerPrefix = prefix.toLowerCase();
        const entries: Array<{
          readonly name: string;
          readonly fullPath: string;
          readonly score: number;
          readonly searchMatch?: { readonly query: string; readonly score: number };
        }> = [];
        for (const directory of directories) {
          for (const dirent of directory.dirents) {
            if (!dirent.isDirectory() || (!showHidden && dirent.name.startsWith("."))) continue;
            const score = input.fuzzy
              ? scoreDirectoryMatch(dirent.name, prefix)
              : dirent.name.toLowerCase().startsWith(lowerPrefix)
                ? 0
                : null;
            if (score !== null)
              entries.push({
                name: dirent.name,
                fullPath: path.join(directory.fullPath, dirent.name),
                score: directory.score + score,
              });
          }
        }

        // Split a compact query across directory names ("wormak" ->
        // "Workspace/makespace"). Each visited level consumes query characters;
        // unrelated branches and symlinks are never recursively crawled.
        if (
          input.fuzzy &&
          prefix.length >= 2 &&
          !entries.some((entry) => entry.name.toLowerCase() === lowerPrefix) &&
          (entries.length === 0 || prefix.length >= 4)
        ) {
          let nodes = directories.map((directory) => ({ ...directory, rest: prefix }));
          for (let depth = 0; depth < 6 && nodes.length > 0; depth += 1) {
            const candidates: Array<{ fullPath: string; rest: string; score: number }> = [];
            for (const node of nodes) {
              for (const child of node.dirents) {
                if (
                  !child.isDirectory() ||
                  (child.name.startsWith(".") && !node.rest.startsWith("."))
                )
                  continue;
                const fullPath = path.join(node.fullPath, child.name);
                if (depth > 0) {
                  const leafScore = scoreDirectoryMatch(child.name, node.rest);
                  if (leafScore !== null) {
                    const score = 5_000 + node.score + leafScore;
                    entries.push({
                      name: child.name,
                      fullPath,
                      score,
                      searchMatch: { query: prefix, score },
                    });
                  }
                }
                if (depth === 5 || remainingReads <= 0) continue;
                for (
                  let split = 1;
                  split < Math.min(node.rest.length, child.name.length + 2);
                  split += 1
                ) {
                  const score = scoreDirectoryMatch(child.name, node.rest.slice(0, split));
                  if (score !== null)
                    candidates.push({
                      fullPath,
                      rest: node.rest.slice(split),
                      score: node.score + score,
                    });
                }
              }
            }
            candidates.sort(
              (left, right) =>
                left.score - right.score || left.fullPath.localeCompare(right.fullPath),
            );
            const uniqueCandidates = new Map<string, (typeof candidates)[number]>();
            for (const candidate of candidates) {
              const key = `${candidate.fullPath}\0${candidate.rest}`;
              if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
              if (uniqueCandidates.size === 20) break;
            }
            const bestCandidates = [...uniqueCandidates.values()];
            yield* Effect.forEach(
              [...new Set(bestCandidates.map((candidate) => candidate.fullPath))],
              (directoryPath) =>
                loadDirectory(directoryPath).pipe(Effect.orElseSucceed(() => undefined)),
              { concurrency: 4 },
            );
            nodes = bestCandidates.flatMap((candidate) => {
              const children = listings.get(candidate.fullPath);
              return children === undefined ? [] : [{ ...candidate, dirents: children }];
            });
          }
        }

        if (!input.fuzzy || entries.length > 0 || (prefix.length === 0 && directories.length > 0)) {
          const rankedEntries = entries.sort(
            (left, right) => left.score - right.score || left.name.localeCompare(right.name),
          );
          const uniqueEntries = new Map<string, (typeof entries)[number]>();
          for (const entry of rankedEntries)
            if (!uniqueEntries.has(entry.fullPath)) uniqueEntries.set(entry.fullPath, entry);
          return {
            parentPath: directories.length === 1 ? directories[0]!.fullPath : parentPath,
            entries: [...uniqueEntries.values()].map(({ name, fullPath, searchMatch }) => ({
              name,
              fullPath,
              ...(searchMatch ? { searchMatch } : {}),
            })),
          };
        }
        const nextAnchor = path.dirname(anchorPath);
        if (
          anchorPath === searchRoot ||
          nextAnchor === anchorPath ||
          missingSegments.length >= 32 ||
          remainingReads <= 0
        ) {
          return { parentPath, entries: [] };
        }
        missingSegments.unshift(path.basename(anchorPath));
        anchorPath = nextAnchor;
      }
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const { entries, throughSymlink } = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            return {
              entries: children.flatMap((child): ProjectEntry[] => {
                if (child.name === ".git" || (!child.isDirectory() && !child.isFile())) return [];
                return [
                  {
                    path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                    kind: child.isDirectory() ? "directory" : "file",
                  },
                ];
              }),
              // Git refuses to classify paths beyond a symbolic link.
              throughSymlink: relative !== target.relativePath.split("/").join(path.sep),
            };
          },
          catch: toError,
        });
        // stdin avoids argument limits; ignore classification is optional without git/repositories.
        const checkIgnore = (paths: ReadonlyArray<string>) =>
          vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: normalizedCwd,
              stdin: `${paths.join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
        // Check ignored folders once to avoid child index lookups; exit 0 guarantees no tracked descendants.
        // Symlinks and pathspec magic still need per-child checks.
        if (
          entries.length > IGNORE_CHECK_CHUNK_SIZE &&
          target.relativePath !== "" &&
          !throughSymlink &&
          !/^:|[*?[\\]/.test(target.relativePath) &&
          (yield* checkIgnore([target.relativePath]))?.exitCode === 0
        ) {
          return {
            entries: entries.map((entry) => ({ ...entry, ignored: true })),
            truncated: false,
          };
        }
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
          const result = yield* checkIgnore(
            entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
          );
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) ignored.add(ignoredPath);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const listIgnoredFiles: WorkspaceEntries["Service"]["listIgnoredFiles"] = Effect.fn(
    "WorkspaceEntries.listIgnoredFiles",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    // `--directory` reports a folder holding nothing but ignored files as one
    // `name/` entry, which is how `node_modules` and build output drop out.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredFiles",
        command: "git",
        args: [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        cwd: normalizedCwd,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!result || result.exitCode !== 0) return { files: [], truncated: false };
    const paths = result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
      .toSorted();
    const files = yield* Effect.promise(() =>
      Promise.all(
        paths.slice(0, IGNORED_FILES_LIMIT).map(async (relativePath) => {
          // lstat: a symlink usually points outside the workspace, where reads refuse to go.
          const stat = await NodeFSP.lstat(path.join(normalizedCwd, relativePath)).catch(
            () => null,
          );
          return stat?.isFile() ? { path: relativePath, byteLength: stat.size } : null;
        }),
      ),
    );
    return {
      files: files.filter((file) => file !== null),
      truncated: paths.length > IGNORED_FILES_LIMIT,
    };
  });

  return WorkspaceEntries.of({ browse, list, listIgnoredFiles, refresh, search, searchContents });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
