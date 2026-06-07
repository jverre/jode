// @jode/agents — declarative agent adapters.
//
// How to launch/identify each hosted agent (Claude Code, Codex, OpenCode):
// display, icon, capabilities, and the Cloudflare Worker URL its web UI is
// served from. Config-driven so adding an agent is data, not code. Imported by
// the desktop app (connectors/rail) and the Cloudflare launcher.
//
// NOTE: apps/desktop/src/main/agents.ts currently holds its own copy of this
// list; it migrates to this package once the desktop app consumes the
// workspace alias (plan 03).

export interface AgentDef {
  /** Stable id; also used as the persistent session partition key. */
  id: string;
  /** Display name (tooltip). */
  name: string;
  /** 1–2 char badge shown in the rail. */
  shortLabel: string;
  /** Accent colour for the rail badge. */
  accent: string;
  /** Cloudflare Worker URL of the hosted agent UI. Undefined → placeholder. */
  url?: string;
}

export const AGENTS: AgentDef[] = [
  { id: "claude-code", name: "Claude Code", shortLabel: "CC", accent: "#D97757" },
  { id: "codex", name: "Codex", shortLabel: "Cx", accent: "#10A37F" },
  { id: "opencode", name: "OpenCode", shortLabel: "OC", accent: "#7C5CFF" },
];

/** Shape sent to the renderer (no internals beyond what the rail needs). */
export function agentInfo(a: AgentDef) {
  return { id: a.id, name: a.name, shortLabel: a.shortLabel, accent: a.accent };
}
