// build-payload.mjs — rebuild the Claude Desktop "linux-rehost" payload from the
// installed macOS app, fully self-contained (no dependency on any external lab
// tree). Produces `payload/linux-rehost/`, which the Dockerfile bakes into the
// container image and wrangler serves as static assets.
//
// Pipeline (was two separate lab scripts, merged here):
//   1. Extract `Claude.app/Contents/Resources/app.asar` → staging/extracted
//   2. Copy `app.asar.unpacked` (native modules) → staging/unpacked
//   3. Assemble payload/linux-rehost/app from extracted + unpacked + resources
//   4. Apply the Linux shims (claude-swift, helpers, bootstrap, package.json,
//      shell-path-worker platform patch) that let the macOS bundle boot headless
//      under forced-Linux Electron in the container.
//
// Source app is /Applications/Claude.app by default; override with CLAUDE_APP_PATH.
// Run from anywhere: `npm run build:payload` (in apps/claude-code).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_APP = process.env.CLAUDE_APP_PATH || "/Applications/Claude.app";
const RESOURCES = path.join(CLAUDE_APP, "Contents/Resources");
const SOURCE_ASAR = path.join(RESOURCES, "app.asar");
const SOURCE_UNPACKED = path.join(RESOURCES, "app.asar.unpacked");

const STAGE = path.join(ROOT, ".payload-build");
const STAGE_EXTRACTED = path.join(STAGE, "extracted");
const STAGE_UNPACKED = path.join(STAGE, "unpacked");

const REHOST_ROOT = path.join(ROOT, "payload", "linux-rehost");
const APP_ROOT = path.join(REHOST_ROOT, "app");

const ELECTRON_VERSION = "41.6.1"; // the ABI the bridge + node-pty build target

// ── fs helpers ───────────────────────────────────────────────────────────────
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
function resetDir(d) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}
function copyTree(source, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      try {
        fs.symlinkSync(target, destPath);
      } catch {
        if (!fs.existsSync(destPath)) throw new Error(`Could not recreate symlink ${srcPath}`);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, fs.statSync(srcPath).mode);
    }
  }
}

// ── 1. ASAR extraction ─────────────────────────────────────────────────────--
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 16);
    return {
      header: JSON.parse(header.toString("utf8")),
      // Claude's ASAR payload begins two bytes after the JSON header block.
      // Without this adjustment, extracted files pick up a stray prefix byte
      // and lose their final byte.
      payloadOffset: 18 + headerSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}
function walkAsar(node, prefix = "") {
  const entries = [];
  if (!node.files) return entries;
  for (const [name, child] of Object.entries(node.files)) {
    const nextPath = `${prefix}/${name}`;
    if (child.files) entries.push(...walkAsar(child, nextPath));
    else
      entries.push({
        path: nextPath,
        size: Number(child.size || 0),
        offset: Number(child.offset || 0),
        executable: Boolean(child.executable),
      });
  }
  return entries;
}
function extractAsar(asarPath, outDir) {
  const { header, payloadOffset } = readAsarHeader(asarPath);
  const files = walkAsar(header);
  const fd = fs.openSync(asarPath, "r");
  try {
    for (const file of files) {
      const destPath = path.join(outDir, file.path);
      ensureDir(path.dirname(destPath));
      const buf = Buffer.alloc(file.size);
      fs.readSync(fd, buf, 0, file.size, payloadOffset + file.offset);
      fs.writeFileSync(destPath, buf);
      if (file.executable) fs.chmodSync(destPath, 0o755);
    }
  } finally {
    fs.closeSync(fd);
  }
  return files;
}

// ── 3. resource selection ────────────────────────────────────────────────────
function copySelectedResources() {
  const resourcesRoot = path.join(APP_ROOT, "resources");
  const i18nRoot = path.join(resourcesRoot, "i18n");
  ensureDir(resourcesRoot);
  ensureDir(i18nRoot);
  for (const entry of fs.readdirSync(RESOURCES, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      fs.copyFileSync(path.join(RESOURCES, entry.name), path.join(i18nRoot, entry.name));
    }
  }
  copyTree(path.join(RESOURCES, "ion-dist"), path.join(resourcesRoot, "ion-dist"));
}

// ── 4. Linux shims & boot wiring ───────────────────────────────────────────--
function writeLinuxSwiftShim() {
  const shimPath = path.join(APP_ROOT, "node_modules/@ant/claude-swift/js/index.js");
  ensureDir(path.dirname(shimPath));
  const shim = `const { EventEmitter } = require("node:events");

function makeCallableStub(result) {
  const fn = function () {
    return result;
  };

  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toStringTag) {
        return "Function";
      }
      return makeCallableStub(result);
    },
    apply() {
      return result;
    },
  });
}

class LinuxSwiftShim extends EventEmitter {
  constructor() {
    super();

    const noop = () => {};
    const asyncFalse = async () => false;
    const asyncNull = async () => null;
    const asyncEmpty = async () => [];

    this.quickAccess = {};
    this.notifications = {
      show: noop,
      close: noop,
      requestPermission: async () => "denied",
    };
    this.desktop = {};
    this.api = {};
    this.midnightOwl = {
      setEnabled: noop,
      isEnabled: asyncFalse,
      enable: noop,
      disable: noop,
    };
    this.vm = {
      isRunning: asyncFalse,
      isGuestConnected: asyncFalse,
    };
    this.hotkey = {
      register: noop,
      unregister: noop,
      unregisterAll: noop,
    };
    this.permissionFixer = {
      fix: asyncFalse,
    };
    this.tearOffHalo = undefined;
    this.sessionHalo = undefined;
    this.wakeScheduler = {
      schedule: asyncFalse,
      cancel: asyncFalse,
    };
    this.updater = {
      checkForUpdates: asyncNull,
      quitAndInstall: noop,
    };
    this.trayUsage = {
      setBusy: noop,
      setIdle: noop,
    };
    this.computerUse = {
      getDisplays: asyncEmpty,
      takeScreenshot: asyncNull,
      click: asyncFalse,
      doubleClick: asyncFalse,
      move: asyncFalse,
      drag: asyncFalse,
      scroll: asyncFalse,
      keyPress: asyncFalse,
      typeText: asyncFalse,
    };

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return makeCallableStub(undefined);
      },
    });
  }
}

module.exports = new LinuxSwiftShim();
`;
  fs.writeFileSync(shimPath, shim);
}

function writeHelperShims() {
  const helpersDir = path.join(REHOST_ROOT, "helpers");
  ensureDir(helpersDir);
  fs.writeFileSync(path.join(helpersDir, "disclaimer-shim.sh"), `#!/bin/sh\nexec "$@"\n`);
  fs.writeFileSync(path.join(helpersDir, "chrome-native-host-shim.sh"), `#!/bin/sh\nexit 0\n`);
  fs.chmodSync(path.join(helpersDir, "disclaimer-shim.sh"), 0o755);
  fs.chmodSync(path.join(helpersDir, "chrome-native-host-shim.sh"), 0o755);
}

function writeDevResourceMount() {
  const mountRoot = path.join(REHOST_ROOT, "dev-resources");
  ensureDir(mountRoot);
  const mountPath = path.join(mountRoot, "app.asar");
  fs.rmSync(mountPath, { recursive: true, force: true });
  // Relative symlink so the payload stays portable across machines/containers.
  fs.symlinkSync("../app", mountPath, "dir");
}

function sanitizeAppPackageJson() {
  const packagePath = path.join(APP_ROOT, "package.json");
  if (!fs.existsSync(packagePath)) return;
  const text = fs.readFileSync(packagePath, "utf8");
  let sanitized = text.startsWith(";\n") ? text.slice(2) : text.startsWith(";") ? text.slice(1) : text;
  let trimmed = sanitized.trimEnd();
  try {
    JSON.parse(trimmed);
  } catch {
    trimmed = `${trimmed}\n}`;
  }
  fs.writeFileSync(packagePath, `${trimmed}\n`);
}

function patchShellPathWorker() {
  const workerPath = path.join(APP_ROOT, ".vite/build/shell-path-worker/shellPathWorker.js");
  if (!fs.existsSync(workerPath)) return;
  const source = fs.readFileSync(workerPath, "utf8");
  const patched = source.replace(
    '  if (process.platform !== "darwin") {\n    return options;\n  }\n',
    '  if (process.env.CLAUDE_LINUX_REHOST === "1" || process.env.CLAUDE_REHOST_FORCE_PLATFORM === "linux" || process.platform !== "darwin") {\n    return options;\n  }\n',
  );
  fs.writeFileSync(workerPath, patched);
}

function writeRehostPackage() {
  const content = {
    name: "claude-desktop-linux-rehost",
    private: true,
    type: "commonjs",
    description: "Unofficial Linux re-host for extracted Claude Desktop assets",
    main: "bootstrap.cjs",
    scripts: {
      start: "electron .",
      "start:forced-linux": "CLAUDE_REHOST_FORCE_PLATFORM=linux electron .",
      inspect: "node -e \"console.log(require('./app/package.json'))\"",
    },
    devDependencies: {
      electron: ELECTRON_VERSION,
    },
  };
  fs.writeFileSync(path.join(REHOST_ROOT, "package.json"), `${JSON.stringify(content, null, 2)}\n`);
}

function writeBootstrap() {
  const content = `const Module = require("node:module");
const path = require("node:path");
const childProcess = require("node:child_process");
const electron = require("electron");

const appRoot = path.resolve(__dirname, "app");
const devResourcesRoot = path.resolve(__dirname, "dev-resources");
const linuxSwiftShim = path.resolve(
  appRoot,
  "node_modules/@ant/claude-swift/js/index.js",
);
const helperRoot = path.resolve(__dirname, "helpers");
const disclaimerShim = path.join(helperRoot, "disclaimer-shim.sh");
const chromeNativeHostShim = path.join(helperRoot, "chrome-native-host-shim.sh");

const originalLoad = Module._load;
const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalExecFileSync = childProcess.execFileSync;
const originalSpawnSync = childProcess.spawnSync;

function makeNoopNative() {
  return {};
}

function rewriteHelperCommand(command) {
  if (typeof command !== "string") {
    return command;
  }
  if (command.endsWith("/Helpers/disclaimer")) {
    return disclaimerShim;
  }
  if (command.endsWith("/Helpers/chrome-native-host")) {
    return chromeNativeHostShim;
  }
  return command;
}

function makePatchedChildProcess(baseModule) {
  return {
    ...baseModule,
    spawn(command, args, options) {
      return originalSpawn.call(this, rewriteHelperCommand(command), args, options);
    },
    execFile(file, args, options, callback) {
      return originalExecFile.call(this, rewriteHelperCommand(file), args, options, callback);
    },
    execFileSync(file, args, options) {
      return originalExecFileSync.call(this, rewriteHelperCommand(file), args, options);
    },
    spawnSync(command, args, options) {
      return originalSpawnSync.call(this, rewriteHelperCommand(command), args, options);
    },
  };
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "node:child_process" || request === "child_process") {
    return makePatchedChildProcess(originalLoad(request, parent, isMain));
  }

  if (request === "@ant/claude-swift" && process.platform !== "darwin") {
    return originalLoad(linuxSwiftShim, parent, isMain);
  }

  if (request === "@ant/claude-native" && process.platform !== "darwin") {
    try {
      return originalLoad(request, parent, isMain);
    } catch (error) {
      console.warn("[linux-rehost] Falling back for @ant/claude-native:", error.message);
      return makeNoopNative();
    }
  }

  if (request === "node-pty" && process.platform !== "darwin") {
    try {
      return originalLoad(request, parent, isMain);
    } catch (error) {
      console.warn("[linux-rehost] Falling back for node-pty:", error.message);
      return {
        spawn() {
          throw new Error("node-pty is not available in this Linux rehost yet");
        },
      };
    }
  }

  return originalLoad(request, parent, isMain);
};

const patchedChildProcess = makePatchedChildProcess(childProcess);
childProcess.spawn = patchedChildProcess.spawn;
childProcess.execFile = patchedChildProcess.execFile;
childProcess.execFileSync = patchedChildProcess.execFileSync;
childProcess.spawnSync = patchedChildProcess.spawnSync;

if (process.env.CLAUDE_REHOST_FORCE_PLATFORM) {
  Object.defineProperty(process, "platform", {
    value: process.env.CLAUDE_REHOST_FORCE_PLATFORM,
  });
}

Object.defineProperty(process, "resourcesPath", {
  value: devResourcesRoot,
});
if (electron.powerMonitor) {
  if (typeof electron.powerMonitor.setListeningForShutdown !== "function") {
    electron.powerMonitor.setListeningForShutdown = () => {};
  }
  if (typeof electron.powerMonitor.blockShutdown !== "function") {
    electron.powerMonitor.blockShutdown = () => {};
  }
  if (typeof electron.powerMonitor.unblockShutdown !== "function") {
    electron.powerMonitor.unblockShutdown = () => {};
  }
  if (process.env.CLAUDE_REHOST_FORCE_PLATFORM === "linux") {
    const noopPowerMonitorRegister = (eventName) => {
      console.warn("[linux-rehost] Ignoring powerMonitor listener:", eventName);
      return electron.powerMonitor;
    };
    electron.powerMonitor.on = (eventName) => noopPowerMonitorRegister(eventName);
    electron.powerMonitor.once = (eventName) => noopPowerMonitorRegister(eventName);
    electron.powerMonitor.addListener = (eventName) => noopPowerMonitorRegister(eventName);
  }
}
electron.app.setAppPath(appRoot);
electron.app.getAppPath = () => appRoot;
process.env.CLAUDE_LINUX_REHOST = "1";
require(path.resolve(appRoot, ".vite/build/index.pre.js"));
`;
  fs.writeFileSync(path.join(REHOST_ROOT, "bootstrap.cjs"), content);
}

function writeNotes() {
  const notes = `# Linux rehost payload (generated)

GENERATED by apps/claude-code/scripts/build-payload.mjs from the installed macOS
Claude bundle (${CLAUDE_APP}). Do not edit by hand — re-run \`npm run build:payload\`.
This whole tree is gitignored.

## Layout
- \`app/\` is the extracted ASAR content
- native unpacked modules from \`app.asar.unpacked\` are merged into \`app/node_modules\`
- desktop locale JSON files are copied into \`app/resources/i18n\`
- static \`ion-dist\` assets are copied into \`app/resources/ion-dist\`
- \`@ant/claude-swift/js/index.js\` is replaced with a Linux shim
- helper shims are written under \`helpers/\`
- a fake packaged-app mount is written under \`dev-resources/app.asar\` (symlink → ../app)
- \`bootstrap.cjs\` intercepts mac-only module loads before the extracted main entry runs
`;
  fs.writeFileSync(path.join(REHOST_ROOT, "NOTES.md"), notes);
}

// ── orchestration ─────────────────────────────────────────────────────────--
function main() {
  if (!fs.existsSync(SOURCE_ASAR)) {
    throw new Error(
      `Cannot find ${SOURCE_ASAR}. Install Claude Desktop, or set CLAUDE_APP_PATH ` +
        `to the .app bundle (e.g. CLAUDE_APP_PATH=/path/to/Claude.app npm run build:payload).`,
    );
  }

  console.log(`[build-payload] source: ${CLAUDE_APP}`);
  resetDir(STAGE);
  ensureDir(STAGE_EXTRACTED);

  console.log("[build-payload] extracting app.asar …");
  const files = extractAsar(SOURCE_ASAR, STAGE_EXTRACTED);

  console.log("[build-payload] copying app.asar.unpacked …");
  if (fs.existsSync(SOURCE_UNPACKED)) copyTree(SOURCE_UNPACKED, STAGE_UNPACKED);

  console.log("[build-payload] assembling payload/linux-rehost/app …");
  resetDir(APP_ROOT);
  copyTree(STAGE_EXTRACTED, APP_ROOT);
  const unpackedModules = path.join(STAGE_UNPACKED, "node_modules");
  if (fs.existsSync(unpackedModules)) copyTree(unpackedModules, path.join(APP_ROOT, "node_modules"));
  copySelectedResources();
  sanitizeAppPackageJson();
  patchShellPathWorker();
  writeLinuxSwiftShim();
  writeHelperShims();
  writeDevResourceMount();
  writeBootstrap();
  writeRehostPackage();
  writeNotes();

  console.log("[build-payload] cleaning staging …");
  fs.rmSync(STAGE, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      { ok: true, extractedFiles: files.length, rehostRoot: REHOST_ROOT, appRoot: APP_ROOT },
      null,
      2,
    ),
  );
}

main();
