#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(root, "packages/container-runtime/scripts");

const targets = [
  { app: "apps/claude-code", scripts: ["mount-workspace.sh", "health-server.mjs", "install-electron-linux.sh"] },
  { app: "apps/codex", scripts: ["mount-workspace.sh", "creds-sync.sh", "health-server.mjs", "install-electron-linux.sh"] },
  { app: "apps/opencode", scripts: ["mount-workspace.sh", "creds-sync.sh"] },
];

for (const target of targets) {
  const outDir = resolve(root, target.app, ".runtime");
  mkdirSync(outDir, { recursive: true });
  for (const script of target.scripts) {
    copyFileSync(resolve(runtime, script), resolve(outDir, script));
  }
}

console.log(`[runtime] synced container runtime scripts for ${targets.length} apps`);
