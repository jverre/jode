import type { AgentDef } from './agents'

// Temporary content for an agent pane until the real Cloudflare-hosted web UI
// is wired in. Rendered into the agent's WebContentsView via a data: URL.
// Styled to match the shadcn light theme used by the shell.
export function placeholderHtml(agent: AgentDef): string {
  const accent = agent.accent
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      body {
        position: relative;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
        color: #18181b;
        background:
          radial-gradient(120% 80% at 50% 0%, ${accent}14 0%, rgba(255,255,255,0) 55%),
          #ffffff;
        -webkit-user-select: none; user-select: none;
        overflow: hidden;
      }

      .tile {
        position: relative;
        width: 92px; height: 92px;
        border-radius: 26px;
        display: flex; align-items: center; justify-content: center;
        font-size: 30px; font-weight: 700; letter-spacing: .5px; color: #fff;
        background: linear-gradient(150deg, ${accent} 0%, color-mix(in srgb, ${accent} 62%, #000) 100%);
        box-shadow: 0 18px 50px ${accent}33, inset 0 1px 0 rgba(255,255,255,.28);
        margin-bottom: 28px;
      }
      .tile::after {
        content: "";
        position: absolute; inset: -2px;
        border-radius: 28px;
        background: radial-gradient(closest-side, ${accent}3d, transparent);
        filter: blur(14px);
        z-index: -1;
        animation: pulse 3.2s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: .5; transform: scale(1); }
        50%      { opacity: .9; transform: scale(1.06); }
      }

      h1 { font-size: 24px; font-weight: 650; margin: 0 0 14px; color: #18181b; }

      .chip {
        font-size: 12px; letter-spacing: .6px; text-transform: uppercase;
        color: #71717a;
        padding: 5px 12px; border-radius: 999px;
        border: 1px solid #e4e4e7; background: #fafafa;
      }

      .wordmark {
        position: absolute; bottom: 26px;
        font-size: 12px; letter-spacing: 3px; text-transform: lowercase;
        color: #d4d4d8;
      }
    </style>
  </head>
  <body>
    <div class="tile">${escapeHtml(agent.shortLabel)}</div>
    <h1>${escapeHtml(agent.name)}</h1>
    <div class="chip">Placeholder</div>
    <div class="wordmark">jode</div>
  </body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      default:
        return '&quot;'
    }
  })
}

export function placeholderDataUrl(agent: AgentDef): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(placeholderHtml(agent))
}
