#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "deploy";
const validCommands = new Set(["deploy", "dry-run"]);
const workspaces = [
  "@jode/selector",
  "@jode/claude-code",
  "@jode/opencode",
  "@jode/codex",
];

if (!validCommands.has(command)) {
  console.error(`usage: node tools/cloud-stack.mjs <${[...validCommands].join("|")}>`);
  process.exit(2);
}

for (const workspace of workspaces) {
  console.log(`[cloud-stack] ${command} ${workspace}`);
  const result = spawnSync("npm", ["run", command, "-w", workspace], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
