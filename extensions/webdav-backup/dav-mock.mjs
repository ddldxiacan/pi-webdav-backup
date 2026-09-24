/**
 * dav-mock.mjs — 内存 WebDAV 服务端（供测试使用）
 * 支持 PROPFIND / MKCOL / PUT / GET / HEAD / DELETE + Basic Auth
 *
 * 可选：
 *   requireAuth: false    不校验认证（用于模拟对象存储）
 *   redirectGetsTo        所有 GET 都 302 到该地址 + 原路径
 *                         （模拟 Cloudreve/群晖把下载重定向到对象存储）
 */

import http from "node:http";

export function startDavServer({
  username = "user",
  password = "pass",
  requireAuth = true,
  redirectGetsTo = null,
} = {}) {
  /** @type {Map<string, Buffer>} */
  const store = new Map();
  const dirs = new Set(["/"]);
  const expectedAuth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  let putCount = 0;
  let getCount = 0;
  let lastAuth = null;

  const server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const key = path.replace(/\/+$/, "") || "/";
    const method = (req.method ?? "GET").toUpperCase();
    lastAuth = req.headers.authorization ?? null;

    if (requireAuth && req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dav"' });
      res.end("unauthorized");
      return;
    }

    if (method === "PROPFIND") {
      const depth = req.headers.depth ?? "0";
      if (!dirs.has(key) && !store.has(key)) {
        res.writeHead(404).end("not found");
        return;
      }
      const prefix = key === "/" ? "/" : `${key}/`;
      const children = [];
      if (depth !== "0") {
        for (const d of dirs) {
          if (d === key) continue;
          if (d.startsWith(prefix)) {
            const rest = d.slice(prefix.length);
            if (rest && !rest.includes("/")) {
              children.push({ href: d, isDir: true, size: 0, lm: new Date().toUTCString() });
            }
          }
        }
        for (const [p, buf] of store) {
          if (p.startsWith(prefix)) {
            const rest = p.slice(prefix.length);
            if (rest && !rest.includes("/")) {
              children.push({ href: p, isDir: false, size: buf.length, lm: new Date().toUTCString() });
            }
          }
        }
      }
      const responses = [
        { href: key, isDir: !store.has(key), size: store.get(key)?.length ?? 0, lm: new Date().toUTCString() },
        ...children,
      ];
      const xml =
        `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n` +
        responses
          .map(
            (e) =>
              `  <D:response><D:href>${e.href}</D:href><D:propstat><D:prop>` +
              `<D:getcontentlength>${e.size}</D:getcontentlength>` +
              `<D:getlastmodified>${e.lm}</D:getlastmodified>` +
              `<D:resourcetype>${e.isDir ? "<D:collection/>" : ""}</D:resourcetype>` +
              `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
          )
          .join("\n") +
        `\n</D:multistatus>`;
      res.writeHead(207, { "Content-Type": "application/xml" }).end(xml);
      return;
    }

    if (method === "MKCOL") {
      if (dirs.has(key) || store.has(key)) {
        res.writeHead(405).end("exists");
        return;
      }
      dirs.add(key);
      res.writeHead(201).end();
      return;
    }

    if (method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        putCount++;
        store.set(key, Buffer.concat(chunks));
        res.writeHead(201).end();
      });
      return;
    }

    if (method === "GET") {
      // 网盘行为：下载不在 WebDAV 侧，302 到对象存储的带签名临时 URL
      if (redirectGetsTo) {
        res.writeHead(302, { Location: `${redirectGetsTo}${path}` });
        res.end();
        return;
      }
      if (!store.has(key)) {
        res.writeHead(404).end();
        return;
      }
      getCount++;
      const buf = store.get(key);
      res.writeHead(200, { "Content-Length": String(buf.length) }).end(buf);
      return;
    }

    if (method === "HEAD") {
      if (!store.has(key)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Length": String(store.get(key).length) }).end();
      return;
    }

    if (method === "DELETE") {
      if (store.delete(key) || dirs.delete(key)) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
      return;
    }

    res.writeHead(405).end("method not allowed");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        store,
        dirs,
        stats: () => ({ putCount, getCount }),
        get lastAuth() {
          return lastAuth;
        },
        reset: () => {
          putCount = 0;
          getCount = 0;
        },
      });
    });
  });
}
