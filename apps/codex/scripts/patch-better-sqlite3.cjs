// Patch better-sqlite3 source for Electron 42+ (V8 >= 14) external-pointer API.
//
// V8 14 (Electron 42, Chromium ~140) enabled the external-pointer sandbox, which
// changed the C++ API: v8::External::New/Value now take an ExternalPointerTypeTag,
// and Template::SetNativeDataProperty's overload set changed so a literal `0`
// setter arg is ambiguous. Released better-sqlite3 (incl. 12.10.0) hasn't adopted
// this, so it fails to compile against Electron 42.
//
// This is a faithful port of ilysenko/codex-desktop-linux's
// patch_better_sqlite3_for_v8_external_pointer_api (scripts/lib/native-modules.sh)
// — the project that runs the Codex desktop app on Linux. Applied to a FRESH npm
// install of better-sqlite3 (the asar's unpacked copy has no src/), then the
// module is rebuilt with @electron/rebuild against the Electron 42 ABI.
//
// Usage: node patch-better-sqlite3.cjs <path-to-better-sqlite3-module>
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const moduleDir = process.argv[2];
if (!moduleDir) {
  console.error("usage: node patch-better-sqlite3.cjs <module-dir>");
  process.exit(2);
}

const files = {
  main: path.join(moduleDir, "src/better_sqlite3.cpp"),
  helpers: path.join(moduleDir, "src/util/helpers.cpp"),
  macros: path.join(moduleDir, "src/util/macros.cpp"),
};

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing better-sqlite3 ${name} source: ${file}`);
  }
}

function replaceOnce(file, needle, replacement) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(replacement)) return false; // already patched
  if (!source.includes(needle)) {
    throw new Error(`Could not find better-sqlite3 V8 external pointer patch needle in ${file}`);
  }
  fs.writeFileSync(file, source.replace(needle, replacement));
  return true;
}

let patched = false;
patched =
  replaceOnce(
    files.main,
    "v8::Local<v8::External> data = v8::External::New(isolate, addon);",
    "v8::Local<v8::External> data = BETTER_SQLITE3_EXTERNAL_NEW(isolate, addon);",
  ) || patched;

patched =
  replaceOnce(
    files.macros,
    `#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())`,
    `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 14
#define BETTER_SQLITE3_EXTERNAL_POINTER_TAG v8::kExternalPointerTypeTagDefault
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), BETTER_SQLITE3_EXTERNAL_POINTER_TAG)
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value(BETTER_SQLITE3_EXTERNAL_POINTER_TAG))
#else
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value())
#endif

#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))`,
  ) || patched;

patched =
  replaceOnce(
    files.helpers,
    `\t\tfunc,
\t\t0,
\t\tdata`,
    `\t\tfunc,
\t\tnullptr,
\t\tdata`,
  ) || patched;

console.error(
  patched
    ? "[patch-better-sqlite3] applied V8 external-pointer API patch"
    : "[patch-better-sqlite3] already patched (no-op)",
);
