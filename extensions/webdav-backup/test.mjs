#!/usr/bin/env node
/**
 * test.mjs — 端到端测试
 *
 * 起一个内存 WebDAV 服务端（支持 PROPFIND/MKCOL/PUT/GET/HEAD/DELETE），
 * 然后跑真实的备份引擎，验证：
 *   1. 归档模式上传成功
 *   2. 加密模式可解回原文件
 *   3. 快照模式增量跳过
 *   4. 脱敏：auth.json 密钥不上传明文
 *   5. glob 排除生效
 *   6. prune 清理旧版本
 *
 * 用法：node test.mjs
 */

import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

import { loadConfig } from "./config.mjs";
import { runBackup, pruneOldArchives } from "./backup.mjs";
import { decryptFile } from "./crypto.mjs";
import { WebDAVClient } from "./webdav.mjs";
import { collectFiles, makeExcluder } from "./collect.mjs";

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    results.push(`  ✅ ${name}`);
  } else {
    fail++;
    results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─────────────────────────────── 内存 WebDAV 服务端
function startDavServer() {
  /** @type {Map<string, Buffer>} */
  const store = new Map();
  const dirs = new Set(["/"]);
  const auth = "Basic " + Buffer.from("user:pass").toString("base64");
  let putCount = 0;
  let getCount = 0;

  const server = http.createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const key = path.replace(/\/+$/, "") || "/";

    if (req.headers.authorization !== auth) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dav"' });
      res.end("unauthorized");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();

    if (method === "PROPFIND") {
      const depth = req.headers.depth ?? "0";
      if (!dirs.has(key) && !store.has(key)) {
        res.writeHead(404).end("not found");
        return;
      }
      const children = [];
      if (depth !== "0") {
        for (const d of dirs) {
          if (d !== key && d.startsWith(key === "/" ? "/" : `${key}/`) && !d.slice(key === "/" ? 1 : key.length + 1).includes("/")) {
            children.push({ href: d, isDir: true, size: 0, lm: new Date().toUTCString() });
          }
        }
        for (const [p, buf] of store) {
          if (p.startsWith(`${key === "/" ? "" : key}/`)) {
            const rest = p.slice(key === "/" ? 1 : key.length + 1);
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
      if (store.delete(key)) {
        res.writeHead(204).end();
        return;
      }
      if (dirs.delete(key)) {
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
        reset: () => {
          putCount = 0;
          getCount = 0;
        },
      });
    });
  });
}

// ─────────────────────────────── 测试主体
async function main() {
  console.log("pi WebDAV 备份 — 端到端测试\n");

  const dav = await startDavServer();
  const baseUrl = `http://127.0.0.1:${dav.port}/dav`;
  dav.dirs.add("/dav");

  // 构造假的 agent 目录
  const agentDir = mkdtempSync(join(tmpdir(), "pi-backup-test-"));
  mkdirSync(join(agentDir, "extensions", "my-ext"), { recursive: true });
  mkdirSync(join(agentDir, "sessions", "proj"), { recursive: true });
  mkdirSync(join(agentDir, "tmp"), { recursive: true });
  mkdirSync(join(agentDir, "npm", "node_modules", "junk"), { recursive: true });

  writeFileSync(join(agentDir, "extensions", "my-ext", "index.ts"), "export default () => {};\n");
  writeFileSync(join(agentDir, "extensions", "note.md"), "# 我的扩展说明\n".repeat(50));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { key: "sk-SECRET-SHOULD-NOT-LEAK", type: "api" } }, null, 2),
  );
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify(
      {
        remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "pi-backup", remoteName: "pi-agent" },
        keepVersions: 2,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(agentDir, "sessions", "proj", "s1.jsonl"), '{"big":"session"}\n');
  writeFileSync(join(agentDir, "tmp", "junk.tmp"), "should be excluded");
  writeFileSync(join(agentDir, "npm", "node_modules", "junk", "index.js"), "module.exports={}");
  writeFileSync(join(agentDir, "npm", "package.json"), '{"name":"x"}');

  process.env.PI_CODING_AGENT_DIR = agentDir;

  // ── 1. 配置加载
  const loaded = loadConfig();
  check("配置加载成功", loaded.ok, loaded.errors.join("; "));
  check("内置排除包含 sessions/**", loaded.config.exclude.includes("sessions/**"));

  // ── 2. glob 排除
  const isExcluded = makeExcluder(["tmp/**", "**/node_modules/**", "sessions/**"]);
  check("排除 tmp/junk.tmp", isExcluded("tmp/junk.tmp"));
  check("排除嵌套 node_modules", isExcluded("npm/node_modules/junk/index.js"));
  check("排除 sessions", isExcluded("sessions/proj/s1.jsonl"));
  check("不排除 extensions/note.md", !isExcluded("extensions/note.md"));

  // ── 3. 文件收集
  const collected = collectFiles({
    agentDir,
    scope: ["."],
    exclude: loaded.config.exclude,
  });
  const rels = collected.files.map((f) => f.rel);
  check("收集到 extensions/note.md", rels.includes("extensions/note.md"));
  check("收集到嵌套扩展文件", rels.includes("extensions/my-ext/index.ts"));
  check("未收集 sessions 文件", !rels.some((r) => r.startsWith("sessions/")));
  check("未收集 tmp 文件", !rels.some((r) => r.startsWith("tmp/")));
  check("未收集 node_modules", !rels.some((r) => r.includes("node_modules/")));

  // ── 4. 连接检查
  const client = new WebDAVClient({ baseUrl, username: "user", password: "pass", timeoutMs: 5000 });
  const conn = await client.check();
  check("WebDAV 连接与认证", conn.ok, conn.error);

  const badAuth = new WebDAVClient({ baseUrl, username: "user", password: "WRONG", timeoutMs: 5000 });
  const badConn = await badAuth.check();
  check("错误密码被识别为认证失败", !badConn.ok && badConn.status === 401, JSON.stringify(badConn));

  // ── 5. dry run 不上传
  dav.reset();
  const dry = await runBackup(loaded.config, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
    dryRun: true,
  });
  check("试运行成功", dry.ok && dry.dryRun === true);
  check("试运行未产生上传", dav.stats().putCount === 0, `putCount=${dav.stats().putCount}`);

  // ── 6. 归档模式
  const arch = await runBackup(loaded.config, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
    reason: "manual",
  });
  check("归档备份成功", arch.ok === true, arch.error);
  check("归档已上传", arch.ok && arch.files > 0, `files=${arch.files}`);
  check("敏感文件已脱敏", arch.redacted > 0, `redacted=${arch.redacted}`);

  const gz = dav.store.get(`/dav/pi-backup/${arch.archive}`);
  check("远端存在归档文件", !!gz && gz.length > 0);

  // ── 7. 解包检查内容 + 脱敏验证
  if (gz) {
    const tar = gunzipSync(gz);
    const text = tar.toString("latin1");
    check("归档含扩展文件", text.includes("extensions/note.md"));
    check("归档含嵌套扩展", text.includes("extensions/my-ext/index.ts"));
    check("归档不含 sessions", !text.includes("sessions/proj"));
    check("归档不含 tmp", !text.includes("junk.tmp"));
    check("归档不含 node_modules", !text.includes("node_modules/junk"));
    check("auth.json 密钥已脱敏", !text.includes("sk-SECRET-SHOULD-NOT-LEAK"), "明文密钥泄漏！");
    check("归档内含 REDACTED 占位", text.includes("__REDACTED__"));
    check("归档含 manifest", text.includes(".pi-backup-manifest.json"));
  } else {
    check("归档内容检查", false, "归档文件缺失，跳过");
  }

  // ── 8. 加密模式
  const encConfig = { ...loaded.config, encrypt: true, encryptKey: "a-very-secret-passphrase-123", remoteName: "pi-enc" };
  const enc = await runBackup(encConfig, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
    reason: "manual",
  });
  check("加密备份成功", enc.ok === true, enc.error);
  check("加密归档名以 .pibak 结尾", String(enc.archive).endsWith(".pibak"), String(enc.archive));

  const encBlob = dav.store.get(`/dav/pi-backup/${enc.archive}`);
  check("加密文件已上传", !!encBlob);
  if (encBlob) {
    check("密文中不含明文密钥", !encBlob.toString("latin1").includes("sk-SECRET-SHOULD-NOT-LEAK"));
    check("密文不含明文文件名", !encBlob.toString("latin1").includes("extensions/note.md"));
  }

  // 解密回原样
  if (encBlob) {
    const outFile = join(agentDir, "decrypted.tar.gz");
    const encFile = join(agentDir, "roundtrip.pibak");
    writeFileSync(encFile, encBlob);
    const dec = await decryptFile(encFile, outFile, "a-very-secret-passphrase-123");
    check("解密成功并返回 header", !!dec.header && dec.header.name === enc.archive);
    const plain = gunzipSync(readFileSync(outFile));
    const plainText = plain.toString("latin1");
    check("解密后可读到扩展文件", plainText.includes("extensions/note.md"));
    check("解密后仍不含明文密钥", !plainText.includes("sk-SECRET-SHOULD-NOT-LEAK"));

    // 错误密码必须失败
    let wrongFailed = false;
    try {
      await decryptFile(encFile, join(agentDir, "wrong.tar.gz"), "wrong-password-here-xxxx");
    } catch {
      wrongFailed = true;
    }
    check("错误密码解密失败", wrongFailed);
  }

  // ── 9. 快照模式增量
  const snapConfig = { ...loaded.config, snapshot: true, remoteName: "pi-snap" };
  dav.reset();
  const s1 = await runBackup(snapConfig, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
    reason: "manual",
  });
  check("快照首次备份成功", s1.ok === true, s1.error);
  check("快照首次全部上传", s1.uploaded === s1.files, `uploaded=${s1.uploaded} files=${s1.files}`);

  const firstPutCount = dav.stats().putCount;
  dav.reset();
  const s2 = await runBackup(snapConfig, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
    reason: "manual",
  });
  check("快照第二次备份成功", s2.ok === true, s2.error);
  check("快照第二次跳过未变化文件", s2.skippedSame > 0, `skippedSame=${s2.skippedSame}`);
  check("快照第二次上传显著减少", s2.uploaded < s1.uploaded, `s1=${s1.uploaded} s2=${s2.uploaded}`);
  check("远端有 snapshot manifest", !!dav.store.get("/dav/pi-backup/pi-snap/manifest.json"));
  check("快照保留了目录结构", !!dav.store.get("/dav/pi-backup/pi-snap/extensions/my-ext/index.ts"));

  // 改一个文件后，只有它被重传
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }, null, 2) + "\n");
  dav.reset();
  const s3 = await runBackup(snapConfig, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
    reason: "manual",
  });
  check("改动后备份成功", s3.ok === true, s3.error);
  check("只重传变化的文件（含配置类）", s3.uploaded <= 4, `uploaded=${s3.uploaded}`);

  // ── 10. prune 清理旧版本
  const pruneConfig = { ...loaded.config, remoteName: "pi-prune", remoteDir: "pi-prune-dir" };
  for (let i = 0; i < 4; i++) {
    await runBackup(pruneConfig, {
      log: () => {},
      agentDir,
      stateFile: join(agentDir, "state.json"),
      reason: "manual",
    });
    await new Promise((r) => setTimeout(r, 1100)); // 时间戳精确到秒
  }
  const pruneClient = new WebDAVClient({ baseUrl, username: "user", password: "pass", timeoutMs: 5000 });
  const before = (await pruneClient.list("pi-prune-dir")).filter(
    (e) => !e.isCollection && e.name.startsWith("pi-prune-"),
  ).length;
  // 另一个前缀的备份不应被误删
  const otherBefore = (await pruneClient.list("pi-backup")).filter(
    (e) => !e.isCollection && e.name.startsWith("pi-agent-"),
  ).length;

  const pruned = await pruneOldArchives({ ...pruneConfig }, 2, () => {});
  check("清理旧版本删除了多余归档", pruned.deleted.length === Math.max(0, before - 2), `before=${before} deleted=${pruned.deleted.length}`);
  check("清理保留了指定数量", pruned.kept === 2, `kept=${pruned.kept}`);

  const otherAfter = (await pruneClient.list("pi-backup")).filter(
    (e) => !e.isCollection && e.name.startsWith("pi-agent-"),
  ).length;
  check("未误删其他前缀的备份", otherAfter === otherBefore, `before=${otherBefore} after=${otherAfter}`);

  // ── 11. 断网/错误路径
  const deadClient = new WebDAVClient({ baseUrl: "http://127.0.0.1:1/dav", username: "u", password: "p", timeoutMs: 1500 });
  let deadOk = false;
  try {
    const r = await deadClient.check();
    deadOk = r.ok;
  } catch {
    deadOk = false;
  }
  check("不可达服务器不误报成功", deadOk === false);

  // ── 12. 日志与状态写入
  const stateWritten = existsSync(join(agentDir, "state.json"));
  check("状态文件已写入", stateWritten);
  if (stateWritten) {
    const st = JSON.parse(readFileSync(join(agentDir, "state.json"), "utf8"));
    check("状态含 lastBackupAt", typeof st.lastBackupAt === "string");
  }

  // 清理
  dav.server.close();
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(results.join("\n"));
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(results.join("\n"));
  console.error(`\n测试异常：${e?.stack ?? e}`);
  process.exit(1);
});
