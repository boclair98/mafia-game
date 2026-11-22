/** Local static-export test server. API and WS use the real local backend. */
import http from "node:http";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../out");
const port = Number(process.env.BROWSER_PORT || 3100);
const backend = new URL(process.env.BROWSER_BACKEND_URL || "http://127.0.0.1:8000");
if (!["127.0.0.1", "localhost"].includes(backend.hostname)) {
  throw new Error("The test proxy only connects to a loopback backend");
}
await access(path.join(root, "index.html"));
const types = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const server = http.createServer(async (request, response) => {
  const target = new URL(request.url || "/", "http://127.0.0.1");
  if (target.pathname.startsWith("/api/")) {
    const proxy = http.request({ hostname: backend.hostname, port: backend.port || 80,
      path: request.url, method: request.method, headers: request.headers }, (upstream) => {
      response.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(response);
    });
    proxy.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Local backend unavailable"); });
    request.pipe(proxy);
    return;
  }
  try {
    const decoded = decodeURIComponent(target.pathname);
    let file = path.resolve(root, `.${decoded}`);
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, "index.html");
    if (!(await stat(file).catch(() => null))?.isFile()) {
      if (path.extname(file)) { response.writeHead(404); response.end(); return; }
      file = path.join(root, "index.html");
    }
    response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(400); response.end(); }
});
server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/api/ws?")) { socket.destroy(); return; }
  const upstream = net.connect(Number(backend.port || 80), backend.hostname, () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (let i = 0; i < request.rawHeaders.length; i += 2) upstream.write(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`);
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
server.listen(port, "127.0.0.1", () => console.log(`Static export QA http://127.0.0.1:${port}`));
