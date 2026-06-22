#!/usr/bin/env node
import { spawn } from "node:child_process";
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
const concurrency = parseConcurrency(process.env.JODE_CLOUD_CONCURRENCY, workspaces.length);

if (!validCommands.has(command)) {
  console.error(`usage: node tools/cloud-stack.mjs <${[...validCommands].join("|")}>`);
  process.exit(2);
}

console.log(`[cloud-stack] ${command} ${workspaces.length} app(s), concurrency=${Math.min(concurrency, workspaces.length)}`);

const pending = [...workspaces];
const running = new Set();
const failures = [];

await new Promise((resolve) => {
  function startNext() {
    while (pending.length > 0 && running.size < concurrency && failures.length === 0) {
      const workspace = pending.shift();
      const child = runWorkspace(workspace);
      running.add(child);
      child.once("exit", (code, signal) => {
        running.delete(child);
        if (code !== 0) failures.push({ workspace, code, signal });
        if (failures.length > 0) {
          for (const other of running) other.kill("SIGTERM");
        }
        if ((pending.length === 0 || failures.length > 0) && running.size === 0) resolve();
        else startNext();
      });
    }
  }
  startNext();
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[cloud-stack] ${failure.workspace} failed (${failure.signal || failure.code})`);
  }
  process.exit(1);
}

function runWorkspace(workspace) {
  const label = workspace.replace("@jode/", "");
  console.log(`[cloud-stack:${label}] ${command} start`);
  const child = spawn("npm", ["run", command, "-w", workspace], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  prefixStream(child.stdout, label, false);
  prefixStream(child.stderr, label, true);
  child.once("exit", (code, signal) => {
    if (code === 0) console.log(`[cloud-stack:${label}] ${command} done`);
    else console.error(`[cloud-stack:${label}] ${command} failed (${signal || code})`);
  });
  return child;
}

function prefixStream(stream, label, isError) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) writePrefixedLine(label, line, isError);
  });
  stream.on("end", () => {
    if (buffer) writePrefixedLine(label, buffer, isError);
  });
}

function writePrefixedLine(label, line, isError) {
  const write = isError ? process.stderr.write.bind(process.stderr) : process.stdout.write.bind(process.stdout);
  write(`[${label}] ${line}\n`);
}

function parseConcurrency(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}
