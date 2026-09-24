#!/usr/bin/env node
/**
 * test-restore.mjs — 恢复流程测试
 *
 * 验证：
 *   1. listBackups 能列出归档与快照
 *   2. 归档恢复：解出全部文件且内容一致
 *   3. 加密归档恢复：需要正确密钥
 *   4. 快照恢复：逐文件还原
 *   5. tar 解包拒绝目录穿越
 *   6. 未指定 --to 时落到临时目录，不覆盖原目录
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startDavServer } from "./dav-mock.mjs";
import { loadConfig } from "./config.mjs";
import { runBackup } from "./backup.mjs";
import { restoreBackup, listBackups } from "./restore.mjs";
import { extractTar } from "./tar.mjs";
import { WebDAVClient } from "./webdav.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const lines = [];
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    lines.push(`  ✅ ${n}`);
  } else {
    fail++;
    lines.push(`  ❌ ${n}${d ? ` — ${d}` : ""}`);
  }
};

async function main() {
  console.log("pi WebDAV 备份 — 恢复流程测试\n");

  const dav = await startDavServer();
  const baseUrl = `http://127.0.0.1:${dav.port}/dav`;
  dav.dirs.add("/dav");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-restore-test-"));
  mkdirSync(join(agentDir, "extensions", "deep", "nested"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "one.ts"), "// one\n");
  writeFileSync(join(agentDir, "extensions", "deep", "two.ts"), "// two\n");
  writeFileSync(join(agentDir, "extensions", "deep", "nested", "three.json"), '{"three":true}\n');
  writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark","x":1}\n');
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ k: "sk-CANARY-2" }));
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify({
      remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi" },
      encrypt: false,
      includeSessions: false,
    }),
  );

  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loaded = loadConfig();
  check("配置加载", loaded.ok, loaded.errors.join("; "));
  const config = loaded.config;

  // 1. 先做一个普通归档
  const bk = await runBackup(config, { log: () => {}, agentDir, stateFile: join(agentDir, "state.json") });
  check("归档备份成功", bk.ok === true, bk.error);

  // 2. listBackups
  const listing = await listBackups(config);
  check("listBackups 列出归档", listing.archives.length === 1, `archives=${listing.archives.length}`);
  check("listBackups 无快照时不报错", listing.snapshot === null);

  // 3. 恢复到指定目录
  const dest = join(agentDir, "restored-to");
  const r1 = await restoreBackup(config, { agentDir, file: null, to: dest, log: () => {} });
  check("归档恢复成功", r1.ok === true, JSON.stringify(r1));
  check("恢复到指定目录", r1.dest === dest);
  check("恢复出 one.ts", existsSync(join(dest, "extensions", "one.ts")));
  check("恢复出嵌套 three.json", existsSync(join(dest, "extensions", "deep", "nested", "three.json")));
  check("恢复出 settings.json", existsSync(join(dest, "settings.json")));
  check(
    "恢复内容与原始一致",
    readFileSync(join(dest, "extensions", "deep", "nested", "three.json"), "utf8") === '{"three":true}\n',
  );
  check(
    "恢复的 auth.json 仍是脱敏版（不含明文密钥）",
    !readFileSync(join(dest, "auth.json"), "utf8").includes("sk-CANARY-2"),
  );

  // 4. 加密归档恢复
  const encConfig = { ...config, encrypt: true, encryptKey: "restore-test-secret-key-1", remoteName: "pi-enc" };
  const encBk = await runBackup(encConfig, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
  });
  check("加密备份成功", encBk.ok === true, encBk.error);

  const encDest = join(agentDir, "restored-enc");
  const r2 = await restoreBackup(encConfig, { agentDir, to: encDest, log: () => {} });
  check("加密归档恢复成功", r2.ok === true, JSON.stringify(r2));
  check("加密恢复报告 encrypted=true", r2.encrypted === true);
  check("加密恢复出 one.ts", existsSync(join(encDest, "extensions", "one.ts")));

  // 错误密钥
  const wrongKeyConfig = { ...encConfig, encryptKey: "totally-wrong-key-value" };
  let wrongOk = true;
  let wrongErr = "";
  try {
    const rw = await restoreBackup(wrongKeyConfig, {
      agentDir,
      to: join(agentDir, "restored-wrong"),
      log: () => {},
    });
    wrongOk = rw.ok;
    wrongErr = String(rw.error ?? "");
  } catch (e) {
    wrongOk = false;
    wrongErr = String(e.message);
  }
  check("错误密钥恢复失败", wrongOk === false, wrongErr);

  // 无密钥时给出明确提示
  const noKeyConfig = { ...encConfig, encryptKey: null };
  const rn = await restoreBackup(noKeyConfig, { agentDir, to: join(agentDir, "restored-nokey"), log: () => {} });
  check("缺密钥时提示明确", rn.ok === false && /encryptKey|密钥/.test(String(rn.error)), JSON.stringify(rn));

  // 5. 快照恢复
  const snapConfig = { ...config, snapshot: true, remoteName: "pi-snap" };
  const snapBk = await runBackup(snapConfig, {
    log: () => {},
    agentDir,
    stateFile: join(agentDir, "state.json"),
  });
  check("快照备份成功", snapBk.ok === true, snapBk.error);

  const snapListing = await listBackups(snapConfig);
  check("listBackups 识别快照", !!snapListing.snapshot, JSON.stringify(snapListing.snapshot));

  const snapDest = join(agentDir, "restored-snap");
  const r3 = await restoreBackup(snapConfig, { agentDir, file: "pi-snap", to: snapDest, log: () => {} });
  check("快照恢复成功", r3.ok === true, JSON.stringify(r3));
  check("快照恢复出文件", existsSync(join(snapDest, "extensions", "one.ts")));
  check("快照恢复出嵌套文件", existsSync(join(snapDest, "extensions", "deep", "nested", "three.json")));

  // 6. 恢复不存在的文件
  const r4 = await restoreBackup(config, { agentDir, file: "不存在.tar.gz", to: join(agentDir, "x"), log: () => {} });
  check("指定不存在的备份时失败并列出可选", r4.ok === false && Array.isArray(r4.available));

  // 7. listOnly
  const r5 = await restoreBackup(config, { agentDir, listOnly: true, log: () => {} });
  check("listOnly 只列不下载", r5.ok === true && r5.listOnly === true && Array.isArray(r5.archives));

  // 8. tar 目录穿越防护
  const evilDir = mkdtempSync(join(tmpdir(), "pi-evil-"));
  const evilTar = join(evilDir, "evil.tar");
  // 手工构造一个含 ../../evil.txt 的 tar
  {
    const name = Buffer.from("../../evil.txt", "utf8");
    const hdr = Buffer.alloc(512);
    name.copy(hdr, 0);
    hdr.write("0000644\0", 100, 8, "ascii");
    hdr.write("0000000\0", 108, 8, "ascii");
    hdr.write("0000000\0", 116, 8, "ascii");
    hdr.write("00000000005\0", 124, 12, "ascii");
    hdr.write("00000000000\0", 136, 12, "ascii");
    hdr.write("        ", 148, 8, "ascii");
    hdr.write("0", 156, 1, "ascii");
    hdr.write("ustar\0", 257, 6, "ascii");
    hdr.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of hdr) sum += b;
    hdr.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const body = Buffer.alloc(512);
    body.write("PWNED", 0, "utf8");
    const end = Buffer.alloc(1024);
    writeFileSync(evilTar, Buffer.concat([hdr, body, end]));
  }
  let traversalBlocked = false;
  try {
    await extractTar(evilTar, join(evilDir, "out"));
  } catch (e) {
    traversalBlocked = /不安全路径/.test(String(e.message));
  }
  check("tar 解包拒绝目录穿越", traversalBlocked);
  check("穿越文件未被写出", !existsSync(join(tmpdir(), "evil.txt")) && !existsSync(join(evilDir, "evil.txt")));

  // 9. 未指定 --to 时不动原目录
  const beforeSettings = readFileSync(join(agentDir, "settings.json"), "utf8");
  const r6 = await restoreBackup(config, { agentDir, log: () => {} });
  check("默认恢复到临时目录", r6.ok === true && r6.dest.includes("pi-restore-"), String(r6.dest));
  check("未覆盖原文件", readFileSync(join(agentDir, "settings.json"), "utf8") === beforeSettings);

  dav.server.close();
  try {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(evilDir, { recursive: true, force: true });
    if (r6.dest && r6.dest.includes("pi-restore-")) {
      rmSync(dirname(r6.dest), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
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
