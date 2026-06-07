// @jode/sync — the file-sync engine (shared local + remote logic).
//
// Platform-neutral core (watchers, hashing, diff/patch, reconciler, ignore
// rules) with thin local/remote adapters. No Electron or Worker dependencies so
// it can be fuzzed/tested in plain Node — this is the data-loss-risk surface and
// gets the heaviest test coverage.
//
// STUB: interfaces only. The engine lands with the sync milestone (plan 02 step
// 4 / plan 03 step 4).
import type { SyncEvent } from "@jode/protocol";

/** A two-way sync adapter — one for the laptop, one for the container. */
export interface SyncAdapter {
  /** Watch the workspace and emit changes. */
  watch(onEvent: (event: SyncEvent) => void): Promise<void>;
  /** Apply an inbound change from the other side. */
  apply(event: SyncEvent): Promise<void>;
  /** Read file contents for a path relative to the workspace root. */
  read(path: string): Promise<Uint8Array>;
  stop(): Promise<void>;
}

export interface SyncEngineOptions {
  /** Absolute path to the workspace root being synced. */
  root: string;
  /** Glob patterns to ignore (node_modules, .git, …). */
  ignore?: string[];
}

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.DS_Store",
];
