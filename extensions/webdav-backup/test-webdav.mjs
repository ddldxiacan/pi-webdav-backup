#!/usr/bin/env node
/**
 * test-webdav.mjs — WebDAV 客户端健壮性测试
 *
 * 背景：网盘在并发上传/维护时返回 423 Locked / 429 / 5xx；此前无任何重试，
 * 一次抖动就让整次备份失败（实测：两份 backup 插件同时退出 → 423）。
 *
 * 验证：
 *   1. PUT 遇 423 Locked → 自动重试并最终成功
 *   2. Retry-After 头被尊重（不改变正确性，仅验证不报错）
 *   3. 持续 423 超过重试上限时明确失败（不会无限重试）
 *   4. check/list/统计仍正常
 */

import { startDavServer } from "./dav-mock.mjs";
import { WebDAVClient } from "./webdav.mjs";

let pass = 0;
let fail = 0;
const lines = [];
const check = (n, c, d = "") => {
  if (c) { pass++; lines.push(`  ✅ ${n}`); }
  else { fail++; lines.push(`  ❌ ${n}${d ? ` — ${d}` : ""}`); }
};

async function main() {
  console.log("pi WebDAV 备份 — WebDAV 客户端健壮性测试\n");

  // ── 1. PUT 前 2 次返回 423，之后成功（验证重试）
  {
    const dav = await startDavServer({ failFirstPuts: 2 });
    dav.dirs.add("/dav");
    const c = new WebDAVClient({ baseUrl: `http://127.0.0.1:${dav.port}/dav`, username: "user", password: "pass", timeoutMs: 10000 });
    let ok = false, err = null;
    try {
      await c.put("/dav/x.txt", Buffer.from("hello"), { contentType: "text/plain" });
      ok = true;
    } catch (e) { err = e.message; }
    const s = dav.stats();
    check("423 后自动重试并成功", ok === true, err || "");
    check("确实经历了 2 次锁定", s.lockedCount === 2, JSON.stringify(s));
    check("最终成功写入（putCount=1）", s.putCount === 1, JSON.stringify(s));
    const got = await c.get("/dav/x.txt");
    check("重试后内容正确", got && got.toString("utf8") === "hello");
    dav.server.close();
  }

  // ── 2. 持续 423 超过上限 → 明确失败（不悬挂）
  {
    const dav = await startDavServer({ failFirstPuts: 999 });
    dav.dirs.add("/dav");
    const c = new WebDAVClient({ baseUrl: `http://127.0.0.1:${dav.port}/dav`, username: "user", password: "pass", timeoutMs: 10000 });
    const t0 = Date.now();
    let failed = false, msg = "";
    try {
      await c.put("/dav/y.txt", Buffer.from("x"));
    } catch (e) { failed = true; msg = e.message; }
    const ms = Date.now() - t0;
    check("持续 423 最终失败（不无限重试）", failed === true);
    check("错误信息含 HTTP 423", /423/.test(msg), msg);
    check("重试次数有上限（<40s）", ms < 40000, `${ms}ms`);
    dav.server.close();
  }

  // ── 3. 常规操作不受影响
  {
    const dav = await startDavServer();
    dav.dirs.add("/dav");
    const c = new WebDAVClient({ baseUrl: `http://127.0.0.1:${dav.port}/dav`, username: "user", password: "pass", timeoutMs: 10000 });
    const chk = await c.check();
    check("check 正常", chk.ok === true, JSON.stringify(chk));
    await c.mkdirp("dav/sub");
    await c.put("/dav/sub/a.txt", Buffer.from("A"));
    const list = await c.list("dav/sub");
    check("list 能看到刚上传的文件", list.some((e) => e.name === "a.txt" && !e.isCollection), JSON.stringify(list.map((e) => e.name)));
    await c.del("/dav/sub/a.txt");
    const list2 = await c.list("dav/sub");
    check("delete 生效", !list2.some((e) => e.name === "a.txt"));
    dav.server.close();
  }

  console.log(lines.join("\n"));
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(lines.join("\n"));
  console.error(`\n测试异常：${e?.stack ?? e}`);
  process.exit(1);
});
