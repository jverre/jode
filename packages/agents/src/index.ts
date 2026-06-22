// @jode/agents — declarative agent adapters.
//
// How to launch/identify each hosted agent (Claude Code, Codex, OpenCode):
// display, icon, capabilities, and the Cloudflare Worker URL its web UI is
// served from. Config-driven so adding an agent is data, not code.

export type AgentId = "claude-code" | "codex" | "opencode";

export const JODE_URL = "https://jode.jacquesverre.com";

export interface AgentDef {
  /** Stable id; also used as the persistent session partition key. */
  id: AgentId;
  /** Display name (tooltip). */
  name: string;
  /** 1–2 char badge shown in the rail. */
  shortLabel: string;
  /** Accent colour for the rail badge. */
  accent: string;
  /** Cloudflare Worker URL of the hosted agent UI. Required in production. */
  url: string;
}

/**
 * Production hosted URLs — each agent is its own Cloudflare Worker on a
 * subdomain of jode.jacquesverre.com (one Cloudflare Access app over
 * *.jode.jacquesverre.com gates all three with a single login). The desktop app
 * points a native WebContentsView at them; browsers can open them directly.
 */
export const PROD_URLS: Record<string, string> = {
  "claude-code": "https://claude.jode.jacquesverre.com",
  codex: "https://codex.jode.jacquesverre.com",
  opencode: "https://opencode.jode.jacquesverre.com",
};

const BASE_AGENTS: Omit<AgentDef, "url">[] = [
  { id: "claude-code", name: "Claude Code", shortLabel: "CC", accent: "#D97757" },
  { id: "codex", name: "Codex", shortLabel: "Cx", accent: "#10A37F" },
  { id: "opencode", name: "OpenCode", shortLabel: "OC", accent: "#7C5CFF" },
];

export function agentUrlEnvKey(id: string): string {
  return `JODE_${id.replace(/-/g, "_").toUpperCase()}_URL`;
}

export function agentDefs(overrides: Record<string, string | undefined> = {}): AgentDef[] {
  return BASE_AGENTS.map((a) => {
    const override = overrides[agentUrlEnvKey(a.id)]?.trim();
    return { ...a, url: override || PROD_URLS[a.id] };
  });
}

export const AGENTS: AgentDef[] = agentDefs();

/** Shape sent to the shell and pane hosts. */
export function agentInfo(a: AgentDef) {
  return { id: a.id, name: a.name, shortLabel: a.shortLabel, accent: a.accent, url: a.url };
}
