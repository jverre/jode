// login-callback-proxy.mjs — expose the codex app-server's OAuth login server.
//
// "Sign in with ChatGPT" makes the app-server start a one-shot OAuth callback
// server on the container's 127.0.0.1:1455 (the authUrl's redirect_uri is
// http://localhost:1455/auth/callback — fixed by OpenAI's client registration).
// The user completes the OAuth in THEIR browser, so the redirect must travel:
//   user browser → localhost:1455 (host) → published container port 1456 (this
//   forwarder, bound 0.0.0.0) → 127.0.0.1:1455 (the app-server's login server).
// Loopback-bound services are unreachable through `docker -p` directly, hence
// this forwarder. Run the container with `-p 1455:1456`.
import net from "node:net";

const LISTEN_PORT = Number(process.env.LOGIN_PROXY_PORT || 1456);
const TARGET_PORT = Number(process.env.LOGIN_TARGET_PORT || 1455);
const log = (...a) => console.log("[login-callback-proxy]", ...a);

const server = net.createServer((sock) => {
  const up = net.connect(TARGET_PORT, "127.0.0.1");
  log(`conn from ${sock.remoteAddress} → 127.0.0.1:${TARGET_PORT}`);
  sock.pipe(up);
  up.pipe(sock);
  const drop = () => { sock.destroy(); up.destroy(); };
  sock.on("error", drop);
  // ECONNREFUSED here = no login in progress (the login server is one-shot).
  up.on("error", (e) => { log(`target error: ${e.code || e.message}`); drop(); });
});
server.listen(LISTEN_PORT, "0.0.0.0", () =>
  log(`listening on 0.0.0.0:${LISTEN_PORT} → 127.0.0.1:${TARGET_PORT}`)
);
