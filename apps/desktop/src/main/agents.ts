import { agentDefs, agentInfo, type AgentDef } from "@jode/agents";

// Desktop points at the hosted agent URLs by default. Tests and diagnostics can
// still override URLs through JODE_<AGENT>_URL.
export type { AgentDef };

export const AGENTS: AgentDef[] = agentDefs(process.env);

export { agentInfo };
