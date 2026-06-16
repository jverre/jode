// dev-proxy.mjs — local stand-in for the Cloudflare Worker, for fast browser
// testing of the bridge against a STANDALONE container (avoids wrangler-dev's
// flaky local container DO, which resets on Codex's slow emulated boot).
//
//   docker run -d --name codex-bridge -p 18787:8787 -p 1455:1456 \
//     --device /dev/fuse --cap-add SYS_ADMIN \
//     -e CODEX_BOOT_MODE=bridge -e BRIDGE_KEY=dev-bridge-key \
//     -e R2_ENDPOINT=... -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... \
//     jode-codex:test
//   node scripts/dev-proxy.mjs           # serves http://localhost:8790
//
// -p 1455:1456 is REQUIRED for "Sign in with ChatGPT": the OAuth redirect goes to
// http://localhost:1455/auth/callback, which must reach the app-server's login
// server inside the container (via the 0.0.0.0:1456 login-callback-proxy).
//
// --device /dev/fuse --cap-add SYS_ADMIN + the R2_* envs enable the SHARED jode
// filesystem (tigrisfs FUSE mount of one R2 bucket at /workspace — same files in
// claude-code/opencode/codex). Omit them for a local ephemeral /workspace. For
// offline dev, point R2_ENDPOINT at MinIO (add -e R2_PROVIDER=Minio).
//
// Mirrors the Worker's routing: serve injected index.html + /__bridge assets,
// serve webview static assets, proxy /__bridge/boot and the /bridge WS to the
// container (adding ?key).
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEBVIEW = path.join(ROOT, "payload", "linux-rehost", "app", "webview");
const CONTAINER_HOST = "127.0.0.1";
const CONTAINER_PORT = Number(process.env.CONTAINER_PORT || 18787);
const KEY = process.env.BRIDGE_KEY || "dev-bridge-key";
const PORT = Number(process.env.PORT || 8790);

// Load the generated assets (export const NAME = "<json>";).
const gen = fs.readFileSync(path.join(ROOT, "src", "generated-assets.ts"), "utf8");
const ext = (name) => {
  const m = gen.match(new RegExp(`export const ${name} = ("(?:\\\\.|[^"\\\\])*");`));
  return m ? JSON.parse(m[1]) : "";
};
const INDEX_HTML = ext("INDEX_HTML"), BRIDGE_CLIENT_JS = ext("BRIDGE_CLIENT_JS"), PRELOAD_JS = ext("PRELOAD_JS");

const MIME = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".map": "application/json", ".ico": "image/x-icon",
};
const js = (res, body) => { res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); res.end(body); };

function proxyGet(pathname, res) {
  const req = http.request({ host: CONTAINER_HOST, port: CONTAINER_PORT, path: pathname, method: "GET" }, (up) => {
    res.writeHead(up.statusCode || 502, { "content-type": up.headers["content-type"] || "application/json", "cache-control": "no-store" });
    up.pipe(res);
  });
  req.on("error", (e) => { res.writeHead(502); res.end(JSON.stringify({ error: String(e && e.message) })); });
  req.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (p === "/__bridge/bridge-client.js") return js(res, BRIDGE_CLIENT_JS);
  if (p === "/__bridge/preload.js") return js(res, PRELOAD_JS);
  if (p === "/__bridge/boot") return proxyGet("/boot", res);
  if (p === "/healthz") return proxyGet("/healthz", res);
  // static webview assets
  if (p.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(p)) {
    const file = path.join(WEBVIEW, p);
    if (file.startsWith(WEBVIEW) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end("not found"); return;
  }
  // navigation → injected index.html
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(INDEX_HTML);
});

// WS proxy for /bridge — raw socket piping (after the HTTP upgrade it's just TCP).
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/bridge") { socket.destroy(); return; }
  const upstream = net.connect(CONTAINER_PORT, CONTAINER_HOST, () => {
    // rewrite the request line to add ?key, forward headers verbatim.
    const reqLine = `GET /bridge?key=${KEY} HTTP/1.1\r\n`;
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n");
    upstream.write(reqLine + headers + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`[dev-proxy] http://localhost:${PORT}  → container ${CONTAINER_HOST}:${CONTAINER_PORT}`);
  console.log(`[dev-proxy] assets: index=${INDEX_HTML.length}B bridge-client=${BRIDGE_CLIENT_JS.length}B preload=${PRELOAD_JS.length}B`);
});
