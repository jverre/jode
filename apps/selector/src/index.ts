import { AGENTS, type AgentDef, type AgentId } from "@jode/agents";
import { enforceAccess, htmlResponse, textResponse, type AccessEnv } from "@jode/edge";

type Env = AccessEnv;

const ROUTES = new Map<string, AgentId>([
  ["/claude", "claude-code"],
  ["/codex", "codex"],
  ["/opencode", "opencode"],
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await enforceAccess(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);

    if (pathname === "/") return htmlResponse(renderSelector());

    const agentId = ROUTES.get(pathname);
    if (agentId) {
      const agent = AGENTS.find((candidate) => candidate.id === agentId);
      if (!agent) return textResponse("agent not configured", 500);
      return Response.redirect(agent.url, 302);
    }

    return textResponse("not found", 404);
  },
} satisfies ExportedHandler<Env>;

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function renderSelector(): string {
  const cards = AGENTS.map(renderAgentCard).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Jode</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f3ec;
        --ink: #181614;
        --muted: #6e655c;
        --line: rgba(24, 22, 20, 0.14);
        --panel: rgba(255, 255, 255, 0.74);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #171615;
          --ink: #f6efe5;
          --muted: #b5aaa0;
          --line: rgba(246, 239, 229, 0.16);
          --panel: rgba(255, 255, 255, 0.06);
        }
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-height: 100vh;
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(960px, calc(100% - 40px));
        margin: 0 auto;
        padding: 72px 0;
      }

      header {
        max-width: 680px;
        margin-bottom: 32px;
      }

      h1 {
        margin: 0 0 12px;
        font-size: clamp(44px, 8vw, 88px);
        line-height: 0.9;
        letter-spacing: 0;
      }

      p {
        margin: 0;
        color: var(--muted);
        font-size: 18px;
        line-height: 1.5;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }

      .card {
        display: flex;
        min-height: 188px;
        flex-direction: column;
        justify-content: space-between;
        gap: 28px;
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        color: inherit;
        text-decoration: none;
      }

      .card:focus-visible {
        outline: 3px solid currentColor;
        outline-offset: 3px;
      }

      .badge {
        display: inline-grid;
        width: 44px;
        height: 44px;
        place-items: center;
        border-radius: 7px;
        color: #fff;
        font-size: 14px;
        font-weight: 800;
      }

      .name {
        margin: 0 0 6px;
        font-size: 24px;
        font-weight: 760;
        letter-spacing: 0;
      }

      .url {
        overflow-wrap: anywhere;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.35;
      }

      @media (max-width: 720px) {
        main {
          width: min(100% - 28px, 520px);
          padding: 44px 0;
        }

        .grid {
          grid-template-columns: 1fr;
        }

        .card {
          min-height: 156px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Jode</h1>
        <p>One cloud workspace for Claude Code, Codex, and OpenCode. Pick an agent and continue in the same persisted filesystem.</p>
      </header>
      <section class="grid" aria-label="Products">
        ${cards}
      </section>
    </main>
  </body>
</html>`;
}

function renderAgentCard(agent: AgentDef): string {
  const path = agent.id === "claude-code" ? "/claude" : `/${agent.id}`;

  return `<a class="card" href="${path}">
  <span class="badge" style="background: ${escapeHtml(agent.accent)}">${escapeHtml(agent.shortLabel)}</span>
  <span>
    <span class="name">${escapeHtml(agent.name)}</span>
    <span class="url">${escapeHtml(agent.url)}</span>
  </span>
</a>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
