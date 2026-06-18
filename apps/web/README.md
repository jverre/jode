# @jode/web

The jode **web app**: the shared `@jode/shell` (rail + window chrome) with agent
panes rendered as `<iframe>`s, served by a Cloudflare Worker behind the same
Cloudflare Access app as the agents. It renders the *same* rail as the desktop
app — both consume `@jode/shell`; only the pane host differs (native
`WebContentsView` on desktop, `<iframe>` here).

## How it fits together

```
app.jode.jacquesverre.com  ──►  jode-web Worker
                                   ├─ enforceAccess() (verify Access JWT, @jode/auth)
                                   └─ ASSETS.fetch()  → built shell SPA (./dist)
                                        └─ rail (shared) + <iframe> per agent:
                                             claude.jode… / codex.jode… / opencode.jode…
```

The Worker only serves the SPA + gates it; it does **not** proxy agents. Each
pane iframe loads an agent's own hosted Worker directly. Those agent Workers
already strip `X-Frame-Options`/`Content-Security-Policy` from their upstream, so
they are frameable; the shell's `index.html` allows them via
`frame-src https://*.jode.jacquesverre.com`.

Panes are mounted lazily on first activation and kept alive (visibility toggled),
mirroring the desktop's lazy `WebContentsView` create + `setVisible` so switching
never reloads/re-auths a pane.

## Develop

```bash
npm run dev:vite --workspace @jode/web   # SPA only (rail renders; iframes need Access)
npm run dev --workspace @jode/web        # vite build + wrangler dev (Worker + assets)
```

For `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` (sets
`ACCESS_DEV_BYPASS=true` so the Worker serves without a real Access JWT).

## Deploy

```bash
npm run dry-run --workspace @jode/web    # vite build + wrangler deploy --dry-run
npm run deploy  --workspace @jode/web
```

**Cloudflare setup (one-time):** add `app.jode.jacquesverre.com` as a hostname on
the **existing** Access application that already covers `*.jode.jacquesverre.com`
(so `ACCESS_AUD` is unchanged and one login covers the shell + all agents).

## ⚠️ Open risk — Access-in-iframe spike (do this before relying on web)

The web composition rests on one unverified assumption: **once signed into the
shell top-level, the agent iframes authenticate silently via the shared Access
SSO** (redirect-only, no framable login interstitial). Verify on a real deploy:

1. Deploy `jode-web`; add `app.jode.jacquesverre.com` to the Access app.
2. Open `https://app.jode.jacquesverre.com`, complete the Access login (top-level).
3. Click each agent. **Pass:** the pane loads and is interactive. **Fail:** the
   iframe is blank / shows `X-Frame-Options` / refuses to load.

If it fails, the likely causes and fixes (in order):

- **Access login interstitial is being framed** (team domain page sets
  `X-Frame-Options: DENY`). Fix: require a top-level "Connect <agent>" step the
  first time per agent (open the agent URL top-level once to mint its
  `CF_Authorization`, then the iframe loads silently after).
- **JS frame-busting in the proxied app** (`if (top !== self) …`). Fix: neutralize
  it in the agent Worker's injected client (the Workers already inject scripts).
- **Safari/ITP blocking cross-subdomain iframe cookies.** Support
  Chrome/Firefox/Edge first; revisit Safari (or move to a same-origin path-proxy)
  later.

Desktop is unaffected by any of the above — it uses native panes.
