import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.HEALTH_PORT || 8080);
const tmpRoot = process.env.JODE_REHOST_TMP || "/tmp/jode-rehost";
const rehostRoot = process.env.REHOST_ROOT || "/opt/jode-rehost";
const pidFile = process.env.REHOST_PID || path.join(tmpRoot, "electron.pid");
const logFile = process.env.REHOST_LOG || path.join(tmpRoot, "electron.log");
const processPattern = new RegExp(process.env.JODE_HEALTH_PROCESS_PATTERN || "electron|xstartup|health-server|node", "i");

function tmp(name) {
  return path.join(tmpRoot, name);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readNumber(file) {
  const text = readText(file).trim();
  return text ? Number(text) : null;
}

function readJson(file) {
  const text = readText(file);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
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
  return run("ps", ["-ef"])
    .split("\n")
    .filter((line) => processPattern.test(line))
    .join("\n");
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

function parseMap(value) {
  const out = {};
  for (const item of (value || "").split(",")) {
    if (!item.trim()) continue;
    const index = item.indexOf(":");
    if (index <= 0) continue;
    out[item.slice(0, index)] = item.slice(index + 1);
  }
  return out;
}

function appPath(value) {
  return path.isAbsolute(value) ? value : path.join(rehostRoot, value);
}

function tmpOrAbsolute(value) {
  return path.isAbsolute(value) ? value : tmp(value);
}

function buildPidMap() {
  const pids = {
    electron: readNumber(pidFile),
    healthServer: readNumber(tmp("health-server.pid")),
  };
  for (const [name, file] of Object.entries(parseMap(process.env.JODE_HEALTH_PIDS))) {
    pids[name] = readNumber(tmpOrAbsolute(file));
  }
  return pids;
}

function buildFileChecks() {
  const checks = {
    rehostRoot: fileCheck(rehostRoot),
    bootstrap: fileCheck(path.join(rehostRoot, "bootstrap.cjs")),
    appPackage: fileCheck(path.join(rehostRoot, "app/package.json")),
    electronBinary: fileCheck(path.join(rehostRoot, "node_modules/electron/dist/electron")),
  };
  for (const [name, pathname] of Object.entries(parseMap(process.env.JODE_HEALTH_FILE_CHECKS))) {
    checks[name] = fileCheck(appPath(pathname));
  }
  return checks;
}

function buildLogs() {
  const logs = {
    electron: logSummary(logFile),
    entrypoint: logSummary(tmp("entrypoint.log")),
    xstartup: logSummary(tmp("xstartup.log")),
    phases: logSummary(tmp("phases.log")),
    environment: logSummary(tmp("environment.log")),
    electronVersion: logSummary(tmp("electron-version.log")),
    electronLdd: logSummary(tmp("electron-ldd.log")),
    healthServer: logSummary(tmp("health-server.log")),
  };
  for (const [name, file] of Object.entries(parseMap(process.env.JODE_HEALTH_LOGS))) {
    logs[name] = logSummary(tmpOrAbsolute(file));
  }
  return logs;
}

function mountStatus() {
  const mounts = readText("/proc/mounts").split("\n").filter((line) => line.includes("/workspace"));
  return {
    mounted: mounts.length > 0,
    mounts,
    log: tail(readText(tmp("tigrisfs.log")), 40),
  };
}

http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/mount-status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(`${JSON.stringify(mountStatus(), null, 2)}\n`);
      return;
    }

    const pid = readNumber(pidFile);
    const body = {
      ok: true,
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      pid,
      electronAlive: isAlive(pid),
      electronExitCode: readNumber(tmp("electron.exit")),
      logTail: tail(readText(logFile)),
      pids: buildPidMap(),
      phaseTail: tail(readText(tmp("phases.log")), 120),
      status: readJson(tmp("status.json")),
      mount: mountStatus(),
      processSummary: summarizeProcessTable(),
      fileChecks: buildFileChecks(),
      logs: buildLogs(),
    };

    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  })
  .listen(port, "0.0.0.0");
