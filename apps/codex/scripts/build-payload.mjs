// build-payload.mjs — rebuild the OpenAI Codex "linux-rehost" payload from the
// installed macOS Codex app, fully self-contained. Produces `payload/linux-rehost/`,
// which the Dockerfile bakes into the container image and wrangler serves as
// static assets (the `webview/` SPA). Sibling of apps/claude-code's script;
// see plans/june-2026/04-cloudflare-codex.md.
//
// Codex differs from Claude Desktop in ways that simplify *and* complicate this:
//   • The renderer (`webview/`) lives INSIDE app.asar — no external ion-dist/i18n
//     copy step is needed (extraction already lands it in app/webview).
//   • Main entry is `.vite/build/bootstrap.js` (Codex's own bootstrap); we wrap it
//     with an OUTER bootstrap.cjs that applies the Linux shims first.
//   • macOS-only native module is `objc-js` (the Obj-C bridge). We PHYSICALLY
//     replace it with a JS stub in node_modules so every thread/utility-process
//     that requires it gets the stub — a Module._load monkeypatch in the main
//     process would not cover worker.js / utility processes.
//   • node-pty + better-sqlite3 are real natives rebuilt in the Dockerfile against
//     the Linux Electron ABI (not here — this runs on macOS).
//
// Pipeline:
//   1. Extract `Codex.app/Contents/Resources/app.asar` → staging/extracted
//   2. Copy `app.asar.unpacked` (native modules) → staging/unpacked
//   3. Assemble payload/linux-rehost/app from extracted + unpacked
//   4. Apply Linux shims (objc-js stub, outer bootstrap.cjs, rehost package.json,
//      dev-resources mount)
//
// Source app is /Applications/Codex.app by default; override with CODEX_APP_PATH.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_APP = process.env.CODEX_APP_PATH || "/Applications/Codex.app";
const RESOURCES = path.join(CODEX_APP, "Contents/Resources");
const SOURCE_ASAR = path.join(RESOURCES, "app.asar");
const SOURCE_UNPACKED = path.join(RESOURCES, "app.asar.unpacked");

const STAGE = path.join(ROOT, ".payload-build");
const STAGE_EXTRACTED = path.join(STAGE, "extracted");
const STAGE_UNPACKED = path.join(STAGE, "unpacked");

const REHOST_ROOT = path.join(ROOT, "payload", "linux-rehost");
const APP_ROOT = path.join(REHOST_ROOT, "app");

// Match the Codex bundle's Electron (package.json devDependencies.electron).
// install-electron-linux.sh downloads this exact version for linux-x64, and the
// Dockerfile rebuilds node-pty/better-sqlite3 against its ABI.
const ELECTRON_VERSION = "42.1.0";
// Codex's own main entry inside the asar (package.json "main").
const CODEX_MAIN = ".vite/build/bootstrap.js";

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

// ── 1. file walk (count extracted files for the report) ───────────────────────
function walkDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(p));
    else out.push(p);
  }
  return out;
}

// ── 2. Linux shims & boot wiring ──────────────────────────────────────────────

// Physically replace objc-js (macOS Obj-C bridge, prebuilt .node only) with a JS
// stub so every process/thread that requires it on Linux succeeds. The real API
// surface is small and used for macOS-native niceties (menus, window vibrancy,
// accessibility) the headless container doesn't need — a callable proxy returning
// undefined/no-ops keeps the main process from throwing at require time.
function writeObjcJsStub() {
  const modDir = path.join(APP_ROOT, "node_modules/objc-js");
  resetDir(modDir);
  resetDir(path.join(modDir, "dist"));
  const stub = `// Linux rehost stub for objc-js (macOS-only native bridge). The real module
// loads a Mach-O .node; on Linux we return a permissive no-op proxy so any
// require() succeeds and macOS-only calls become harmless no-ops.
"use strict";
function makeCallableStub() {
  const fn = function () { return makeCallableStub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable
      if (prop === Symbol.toPrimitive) return () => undefined;
      if (prop === "default") return makeCallableStub();
      return makeCallableStub();
    },
    apply() { return makeCallableStub(); },
    construct() { return makeCallableStub(); },
  });
}
module.exports = makeCallableStub();
module.exports.default = module.exports;
`;
  fs.writeFileSync(path.join(modDir, "index.js"), stub);
  fs.writeFileSync(path.join(modDir, "dist", "index.js"), stub);
  fs.writeFileSync(
    path.join(modDir, "package.json"),
    `${JSON.stringify(
      { name: "objc-js", version: "1.5.0", main: "dist/index.js", types: "dist/index.d.ts" },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(modDir, "dist", "index.d.ts"),
    "declare const _default: any;\nexport = _default;\n",
  );
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
  let trimmed = text.trimEnd();
  try {
    JSON.parse(trimmed);
  } catch {
    trimmed = `${trimmed}\n}`;
  }
  fs.writeFileSync(packagePath, `${trimmed}\n`);
}

// Read the real Codex app version from the extracted app/package.json. Electron's
// app.getVersion() reads the version of the package it was launched with (the
// OUTER rehost package, via `electron .`), so the rehost package MUST carry the
// real version — otherwise getVersion() returns "0.0" and Codex's Sentry init
// throws "Invalid semantic version: 0.0" at boot.
function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function writeRehostPackage() {
  const content = {
    name: "openai-codex-linux-rehost",
    version: appVersion(),
    private: true,
    type: "commonjs",
    description: "Unofficial Linux re-host for extracted OpenAI Codex desktop assets",
    main: "bootstrap.cjs",
    scripts: {
      start: "electron .",
      "start:forced-linux": "CODEX_REHOST_FORCE_PLATFORM=linux electron .",
      inspect: "node -e \"console.log(require('./app/package.json'))\"",
    },
    devDependencies: {
      electron: ELECTRON_VERSION,
    },
  };
  fs.writeFileSync(path.join(REHOST_ROOT, "package.json"), `${JSON.stringify(content, null, 2)}\n`);
}

// Outer bootstrap: apply Linux compatibility shims, then hand off to Codex's own
// main entry (.vite/build/bootstrap.js). Force the reported platform to linux
// when CODEX_REHOST_FORCE_PLATFORM is set, and harden a few Electron mac-only
// APIs the bundle may call. Loaded as the rehost package's "main".
function writeBootstrap() {
  const content = `const path = require("node:path");
const electron = require("electron");

const appRoot = path.resolve(__dirname, "app");
const devResourcesRoot = path.resolve(__dirname, "dev-resources");

// Defensive: pin app.getVersion() to the real Codex version. Electron derives it
// from the launched package's package.json; if anything resets it, Codex's Sentry
// init throws "Invalid semantic version: 0.0". Embedded at build time.
const APP_VERSION = ${JSON.stringify(appVersion())};
try { electron.app.getVersion = () => APP_VERSION; } catch {}
try { electron.app.setVersion && electron.app.setVersion(APP_VERSION); } catch {}

// Force process.platform BEFORE Codex's main runs, so darwin-only branches are
// skipped on Linux. Opt-in via env so the same payload can also run natively.
if (process.env.CODEX_REHOST_FORCE_PLATFORM) {
  Object.defineProperty(process, "platform", {
    value: process.env.CODEX_REHOST_FORCE_PLATFORM,
  });
}

// powerMonitor.* mac extras some Electron apps call on startup — make them safe.
if (electron.powerMonitor) {
  for (const m of ["setListeningForShutdown", "blockShutdown", "unblockShutdown"]) {
    if (typeof electron.powerMonitor[m] !== "function") electron.powerMonitor[m] = () => {};
  }
}

// resourcesPath normally points at Contents/Resources (where app.asar lives).
// Point it at our dev-resources mount (app.asar -> ../app symlink) so any
// path.join(process.resourcesPath, "app.asar", ...) resolves into the extracted
// tree instead of a real .asar archive.
try {
  Object.defineProperty(process, "resourcesPath", { value: devResourcesRoot });
} catch {}

electron.app.setAppPath(appRoot);
electron.app.getAppPath = () => appRoot;
process.env.CODEX_LINUX_REHOST = "1";

require(path.resolve(appRoot, ${JSON.stringify(CODEX_MAIN)}));
`;
  fs.writeFileSync(path.join(REHOST_ROOT, "bootstrap.cjs"), content);
}

function writeNotes() {
  const notes = `# Codex Linux rehost payload (generated)

GENERATED by apps/codex/scripts/build-payload.mjs from the installed macOS Codex
bundle (${CODEX_APP}). Do not edit by hand — re-run \`npm run build:payload\`.
This whole tree is gitignored.

## Layout
- \`app/\` is the extracted ASAR content (includes \`webview/\` — the renderer SPA)
- native unpacked modules from \`app.asar.unpacked\` are merged into \`app/node_modules\`
- \`node_modules/objc-js\` is replaced with a Linux JS stub
- \`bootstrap.cjs\` applies Linux shims, then requires Codex's own ${CODEX_MAIN}
- a fake packaged-app mount is written under \`dev-resources/app.asar\` (symlink → ../app)

## Native modules rebuilt in the Dockerfile (not here)
- node-pty, better-sqlite3 → rebuilt against Electron ${ELECTRON_VERSION} (linux-x64) ABI
`;
  fs.writeFileSync(path.join(REHOST_ROOT, "NOTES.md"), notes);
}

// ── orchestration ─────────────────────────────────────────────────────────---
function main() {
  if (!fs.existsSync(SOURCE_ASAR)) {
    throw new Error(
      `Cannot find ${SOURCE_ASAR}. Install the Codex app, or set CODEX_APP_PATH ` +
        `to the .app bundle (e.g. CODEX_APP_PATH=/path/to/Codex.app npm run build:payload).`,
    );
  }

  console.log(`[build-payload] source: ${CODEX_APP}`);
  resetDir(STAGE);
  ensureDir(STAGE_EXTRACTED);

  // Use the official @electron/asar extractor (handles the pickle header/offset
  // correctly across asar variants). A hand-rolled byte-offset reader is brittle:
  // an off-by-one corrupts every file (a stray leading byte → main process
  // SyntaxError). npx fetches it on demand; no repo dependency needed.
  console.log("[build-payload] extracting app.asar (via @electron/asar) …");
  execFileSync("npx", ["--yes", "@electron/asar", "extract", SOURCE_ASAR, STAGE_EXTRACTED], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const files = walkDir(STAGE_EXTRACTED);

  console.log("[build-payload] copying app.asar.unpacked …");
  if (fs.existsSync(SOURCE_UNPACKED)) copyTree(SOURCE_UNPACKED, STAGE_UNPACKED);

  console.log("[build-payload] assembling payload/linux-rehost/app …");
  resetDir(APP_ROOT);
  copyTree(STAGE_EXTRACTED, APP_ROOT);
  const unpackedModules = path.join(STAGE_UNPACKED, "node_modules");
  if (fs.existsSync(unpackedModules)) copyTree(unpackedModules, path.join(APP_ROOT, "node_modules"));

  sanitizeAppPackageJson();
  writeObjcJsStub();
  writeDevResourceMount();
  writeBootstrap();
  writeRehostPackage();
  writeNotes();

  console.log("[build-payload] cleaning staging …");
  fs.rmSync(STAGE, { recursive: true, force: true });

  const webviewIndex = path.join(APP_ROOT, "webview", "index.html");
  console.log(
    JSON.stringify(
      {
        ok: true,
        extractedFiles: files.length,
        rehostRoot: REHOST_ROOT,
        appRoot: APP_ROOT,
        webviewIndexExists: fs.existsSync(webviewIndex),
      },
      null,
      2,
    ),
  );
}

main();
