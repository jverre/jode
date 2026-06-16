#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// `npm run dev` — the whole jode stack, locally:
//
//   • wrangler dev for @jode/claude-code   → http://localhost:8787
//   • wrangler dev for @jode/opencode      → http://localhost:8788
//   • the Electron desktop shell, with each agent's WebContentsView pointed at
//     its local Worker via JODE_<ID>_URL (read in apps/desktop/src/main/agents.ts)
//
// The Workers run the real Worker→DO→Container stack under wrangler (Access is
// bypassed locally via ACCESS_DEV_BYPASS in each app's .dev.vars). We wait for
// both Workers to answer before launching Electron so the first webview load
// succeeds, then stream all output with per-process prefixes and tear the whole
// tree down on Ctrl-C or any child exiting.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"
import { existsSync, copyFileSync } from "node:fs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const WORKERS = [
  { name: "claude-code", workspace: "@jode/claude-code", dir: "apps/claude-code", url: "http://localhost:8787", env: "JODE_CLAUDE_CODE_URL" },
  { name: "opencode", workspace: "@jode/opencode", dir: "apps/opencode", url: "http://localhost:8788", env: "JODE_OPENCODE_URL" },
  { name: "codex", workspace: "@jode/codex", dir: "apps/codex", url: "http://localhost:8789", env: "JODE_CODEX_URL" },
]

// Auto-bootstrap .dev.vars from the example so the local Access bypass
// (ACCESS_DEV_BYPASS="true") is present — without it the Worker returns
// "unauthorized: no Cloudflare Access token" and the webview can't load.
for (const w of WORKERS) {
  const devVars = join(root, w.dir, ".dev.vars")
  const example = join(root, w.dir, ".dev.vars.example")
  if (!existsSync(devVars) && existsSync(example)) {
    copyFileSync(example, devVars)
    console.log(`[dev] created ${w.dir}/.dev.vars from .example — fill in real keys (e.g. ANTHROPIC_API_KEY) as needed`)
  }
}

const COLORS = { "claude-code": "\x1b[38;5;209m", opencode: "\x1b[38;5;141m", codex: "\x1b[38;5;42m", desktop: "\x1b[38;5;180m" }
const RESET = "\x1b[0m"
const children = []
let shuttingDown = false

function pipe(name, child) {
  const tag = `${COLORS[name] ?? ""}[${name}]${RESET} `
  const onData = (buf) => {
    const text = buf.toString()
    for (const line of text.split("\n")) if (line.length) process.stdout.write(tag + line + "\n")
  }
  child.stdout?.on("data", onData)
  child.stderr?.on("data", onData)
}

function run(name, args, extraEnv = {}) {
  // detached so each child leads its own process group — killing -pid on
  // shutdown takes down npm AND the wrangler/electron it spawned (no orphans).
  const child = spawn("npm", args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  pipe(name, child)
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(`\n[dev] ${name} exited (code=${code} signal=${signal}); shutting everything down.`)
      shutdown(code ?? 1)
    }
  })
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM")
    } catch {}
  }
  setTimeout(() => process.exit(code), 1500)
}

async function waitForUrl(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shuttingDown) return false
    try {
      // Any HTTP answer (200/401/502/…) means the Worker is up and serving.
      await fetch(url, { method: "GET" })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 600))
    }
  }
  return false
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

console.log("[dev] starting wrangler dev for both agents…")
for (const w of WORKERS) run(w.name, ["run", "dev", "-w", w.workspace])

console.log("[dev] waiting for Workers to come up (first container build can take a minute)…")
const ready = await Promise.all(WORKERS.map((w) => waitForUrl(w.url)))
WORKERS.forEach((w, i) => console.log(`[dev] ${w.name} ${ready[i] ? "ready at " + w.url : "NOT ready (launching anyway — use the rail reload button)"}`))

if (shuttingDown) process.exit(0)

const agentUrlEnv = Object.fromEntries(WORKERS.map((w) => [w.env, w.url]))
console.log("[dev] launching desktop shell with", agentUrlEnv)
run("desktop", ["run", "dev", "-w", "@jode/desktop"], agentUrlEnv)
