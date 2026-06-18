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

/**
 * Production hosted URLs — each agent is its own Cloudflare Worker on a
 * subdomain of jode.jacquesverre.com (one Cloudflare Access app over
 * *.jode.jacquesverre.com gates all three with a single login). The web app
 * frames these directly; the desktop app points a native WebContentsView at them.
 */
export const PROD_URLS: Record<string, string> = {
  "claude-code": "https://claude.jode.jacquesverre.com",
  codex: "https://codex.jode.jacquesverre.com",
  opencode: "https://opencode.jode.jacquesverre.com",
};

export const AGENTS: AgentDef[] = [
  { id: "claude-code", name: "Claude Code", shortLabel: "CC", accent: "#D97757" },
  { id: "codex", name: "Codex", shortLabel: "Cx", accent: "#10A37F" },
  { id: "opencode", name: "OpenCode", shortLabel: "OC", accent: "#7C5CFF" },
].map((a) => ({ ...a, url: PROD_URLS[a.id] }));

/** Shape sent to the rail (no internals beyond what it needs). `hosted` mirrors
 *  whether a Worker URL is configured. */
export function agentInfo(a: AgentDef) {
  return { id: a.id, name: a.name, shortLabel: a.shortLabel, accent: a.accent, hosted: !!a.url };
}
