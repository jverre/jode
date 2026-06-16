import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import childProcess from "node:child_process";

const port = Number(process.env.HEALTH_PORT || 8080);
const pidFile = process.env.REHOST_PID || "/tmp/claude-rehost/electron.pid";
const logFile = process.env.REHOST_LOG || "/tmp/claude-rehost/electron.log";
const exitFile = "/tmp/claude-rehost/electron.exit";
const entrypointLog = "/tmp/claude-rehost/entrypoint.log";
const kasmLog = "/tmp/claude-rehost/kasmvnc.log";
const kasmUserLog = "/tmp/claude-rehost/kasm-user.log";
const healthLog = "/tmp/claude-rehost/health-server.log";
const xstartupLog = "/tmp/claude-rehost/xstartup.log";
const phaseLog = "/tmp/claude-rehost/phases.log";
const envLog = "/tmp/claude-rehost/environment.log";
const electronVersionLog = "/tmp/claude-rehost/electron-version.log";
const electronLddLog = "/tmp/claude-rehost/electron-ldd.log";
const statusJson = "/tmp/claude-rehost/status.json";
const healthPidFile = "/tmp/claude-rehost/health-server.pid";
const kasmPidFile = "/tmp/claude-rehost/kasmvnc.pid";
const rehostRoot = process.env.REHOST_ROOT || "/opt/claude-rehost";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readPid() {
  const text = readText(pidFile).trim();
  return text ? Number(text) : null;
}

function readExitCode() {
  const text = readText(exitFile).trim();
  return text ? Number(text) : null;
}

function readJson(file) {
  const text = readText(file);
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tail(text, lines = 80) {
  return text.split("\n").slice(-lines).join("\n");
}

function logSummary(file) {
  const text = readText(file);
  return {
    path: file,
    exists: fs.existsSync(file),
    bytes: text.length,
    tail: tail(text),
  };
}

function run(command, args) {
  try {
    return childProcess.execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return error?.stdout || error?.stderr || String(error);
  }
}

function summarizeProcessTable() {
  return run("ps", ["-ef"]).split("\n").filter((line) => {
    const lower = line.toLowerCase();
    return /(electron|xstartup|kasm|vnc|health-server|node)/.test(lower);
  }).join("\n");
}

function fileCheck(pathname) {
  try {
    const stat = fs.statSync(pathname);
    return {
      path: pathname,
      exists: true,
      size: stat.size,
      mode: stat.mode.toString(8),
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return {
      path: pathname,
      exists: false,
    };
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    // Shared-filesystem mount diagnostics (tigrisfs log + mount table).
    if (url.pathname === "/mount-status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        mounted: /\/workspace/.test(readText("/proc/mounts")),
        mounts: readText("/proc/mounts").split("\n").filter((l) => l.includes("/workspace")),
        log: tail(readText("/tmp/codex-rehost/tigrisfs.log"), 40),
      }, null, 2) + "\n");
      return;
    }
    const pid = readPid();
    const log = readText(logFile);
    const exitCode = readExitCode();
    const body = {
      ok: true,
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      pid,
      electronAlive: isAlive(pid),
      electronExitCode: exitCode,
      logTail: tail(log),
      pids: {
        electron: pid,
        healthServer: Number(readText(healthPidFile).trim()) || null,
        kasmvnc: Number(readText(kasmPidFile).trim()) || null,
      },
      phaseTail: tail(readText(phaseLog), 120),
      status: readJson(statusJson),
      processSummary: summarizeProcessTable(),
      fileChecks: {
        rehostRoot: fileCheck(rehostRoot),
        bootstrap: fileCheck(`${rehostRoot}/bootstrap.cjs`),
        appPackage: fileCheck(`${rehostRoot}/app/package.json`),
        appMain: fileCheck(`${rehostRoot}/app/.vite/build/index.pre.js`),
        rendererIndex: fileCheck(`${rehostRoot}/app/resources/ion-dist/index.html`),
        electronBinary: fileCheck(`${rehostRoot}/node_modules/electron/dist/electron`),
      },
      logs: {
        electron: logSummary(logFile),
        entrypoint: logSummary(entrypointLog),
        xstartup: logSummary(xstartupLog),
        phases: logSummary(phaseLog),
        environment: logSummary(envLog),
        electronVersion: logSummary(electronVersionLog),
        electronLdd: logSummary(electronLddLog),
        kasmvnc: logSummary(kasmLog),
        kasmUserSetup: logSummary(kasmUserLog),
        healthServer: logSummary(healthLog),
      },
    };

    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  })
  .listen(port, "0.0.0.0");
