#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipDeploy = process.env.JODE_SKIP_DEPLOY === "1";

function run(args) {
  const result = spawnSync("npm", args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!skipDeploy) {
  console.log("[dev] deploying hosted Jode stack before launching desktop");
  run(["run", "deploy"]);
} else {
  console.log("[dev] JODE_SKIP_DEPLOY=1; launching desktop against existing hosted stack");
}

run(["run", "dev", "-w", "@jode/desktop"]);
