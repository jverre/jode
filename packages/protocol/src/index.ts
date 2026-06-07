// @jode/protocol — shared wire contracts (single source of truth).
//
// Every message crossing the wire between the desktop app, the Cloudflare
// remote env, and the sync layer is typed here. Both ends compile against this
// package so a breaking change fails CI on both sides at once.
//
// STUB: the bridge RPC envelopes below mirror the shapes the `cloudflare-split`
// prototype's bridge.cjs / bridge-client.js already speak over the `/bridge`
// WebSocket. Sync + PTY frames are placeholders to be filled as those
// milestones land (see plans/june-2026/01-repo-architecture.md).

// ── Bridge RPC (browser SPA ↔ headless Electron main, over /bridge WS) ───────

/** A renderer→main `ipcRenderer.invoke` relayed over the bridge. */
export interface BridgeInvokeRequest {
  type: "invoke";
  /** Correlation id matched by the response. */
  id: string;
  channel: string;
  args: unknown[];
}

/** The main→renderer reply to a {@link BridgeInvokeRequest}. */
export interface BridgeInvokeResponse {
  type: "invoke:result";
  id: string;
  result?: unknown;
  error?: { message: string; stack?: string };
}

/** A main→renderer push (`webContents.send`) fanned out over the bridge. */
export interface BridgePushEvent {
  type: "push";
  channel: string;
  args: unknown[];
}

export type BridgeMessage =
  | BridgeInvokeRequest
  | BridgeInvokeResponse
  | BridgePushEvent;

// ── File sync (placeholder — see packages/sync) ──────────────────────────────

export type SyncEventKind = "create" | "modify" | "delete";

export interface SyncEvent {
  kind: SyncEventKind;
  /** Path relative to the workspace root. */
  path: string;
  /** Content hash for conflict detection; absent for deletes. */
  hash?: string;
  mtimeMs?: number;
}

export const PROTOCOL_VERSION = 1 as const;
