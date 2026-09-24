#!/usr/bin/env node
/**
 * test-empty-cmd.mjs — 空参数 / 子命令解析回归测试
 *
 * 事故回归：`/backup` 不带参数时 `"".trim().split(/\s+/)[0]` 是 `""`
 * （不是 undefined），`?? "run"` 兜底失效，空串被当命令传给 CLI，
 * 报出「未知命令：」（冒号后为空）。这里锁住三层防御：
 *   1. pickCommand() 的单元语义（ts 入口与 cli.mjs 共用）
 *   2. 源码不变量：两个入口都必须走 pickCommand，禁止退回 ?? 写法
 *   3. cli.mjs 真实子进程：空 token 默认 backup / 被跳过 / 真未知命令仍报错
 *
 * 用法：node test-empty-cmd.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pickCommand } from "./args.mjs";
import { startDavServer } from "./dav-mock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.mjs");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const lastJson = (out) => {
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  try {
    return JSON.parse(line ?? "{}");
  } catch {
    return {};
  }
};

async function main() {
  console.log("pi WebDAV 备份 — 空参数解析回归测试\n");

  // ── 1. pickCommand 单元语义
  check('pickCommand(["run"], "backup") → "run"', pickCommand(["run"], "backup") === "run");
  check('pickCommand([""], "run") → 兜底 "run"（事故场景）', pickCommand([""], "run") === "run");
  check('pickCommand([], "run") → 兜底', pickCommand([], "run") === "run");
  check('pickCommand(null, "backup") → 兜底', pickCommand(null, "backup") === "backup");
  check('pickCommand(["", "", ""], "run") → 兜底', pickCommand(["", "", ""], "run") === "run");
  check('pickCommand(["", "check", "--json"], "run") → "check"', pickCommand(["", "check", "--json"], "run") === "check");
  check('pickCommand(["", "backup", "--reason", "manual"], "run") → "backup"', pickCommand(["", "backup", "--reason", "manual"], "run") === "backup");
  check('pickCommand(["  Run  "], "run") → "run"（trim + 小写）', pickCommand(["  Run  "], "run") === "run");

  // ── 2. 源码不变量：两个入口都必须走 pickCommand（防退回 ?? 空串绕过的写法）
  // 反模式断言只查代码行：注释里引用的反例不算
  const codeOnly = (src) =>
    src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  const tsSrc = readFileSync(join(here, "..", "webdav-backup.ts"), "utf8");
  const cliSrc = readFileSync(CLI, "utf8");
  check("入口 webdav-backup.ts 用 pickCommand 解析子命令", tsSrc.includes("pickCommand(args.trim()"));
  check('入口不再有 `?? "run"` 兜底写法', !codeOnly(tsSrc).includes('?? "run"'));
  check('cli.mjs 用 pickCommand 解析命令', cliSrc.includes('pickCommand(args, "backup")'));
  check('cli.mjs 不再有 `args[0] ?? "backup"` 写法', !codeOnly(cliSrc).includes('args[0] ?? "backup"'));

  // ── 3. cli.mjs 真实子进程行为（内存 WebDAV + 临时 agentDir）
  const dav = await startDavServer();
  const baseUrl = `http://127.0.0.1:${dav.port}/dav`;
  dav.dirs.add("/dav");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-emptycmd-test-"));
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "a.ts"), "export default () => {};\n");
  writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify({
      enabled: true,
      remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi" },
      scope: ["."],
      includeSessions: false,
      encrypt: false,
      keepVersions: 3,
    }),
  );
  const env = { PI_CODING_AGENT_DIR: agentDir };

  // 3a. 事故路径：命令 token 为空串 → 默认 backup，绝不报「未知命令：」
  const empty = await runCli([""], env);
  check(
    'cli.mjs [""] 默认执行 backup（事故路径回归）',
    empty.code === 0 && empty.stdout.includes("完成"),
    `code=${empty.code} out=${empty.stdout.trim()} err=${empty.stderr.trim()}`,
  );
  check(
    "空命令不再出现「未知命令：」",
    !empty.stdout.includes("未知命令"),
    empty.stdout.trim(),
  );

  // 3b. 空 token 被跳过，其后的真命令正常执行
  const chk = await runCli(["", "check", "--json"], env);
  const chkJson = lastJson(chk.stdout);
  check(
    'cli.mjs ["", "check"] 跳过空 token 执行 check',
    chk.code === 0 && chkJson.ok === true,
    `code=${chk.code} out=${chk.stdout.trim()}`,
  );

  // 3c. 真正的未知命令仍要明确报错（错误里带命令名）
  const bad = await runCli(["no-such-cmd", "--json"], env);
  const badJson = lastJson(bad.stdout);
  check(
    "未知命令仍报错且带命令名",
    bad.code === 1 && badJson.ok === false && String(badJson.error).includes("no-such-cmd"),
    JSON.stringify(badJson),
  );

  // 3d. 输出契约：人类模式末行必须是 JSON 汇总（/backup 的「备份完成 ✅」提醒靠它）
  const sum = lastJson(empty.stdout);
  check(
    "人类模式末行是 JSON 汇总（ok + remotePath + files）",
    sum.ok === true && typeof sum.remotePath === "string" && Number(sum.files) >= 1,
    empty.stdout.trim().split("\n").pop(),
  );

  // 3e. 失败时汇总必须带非空 error（否则前端只能弹「失败：」空提醒）
  const noConfDir = mkdtempSync(join(tmpdir(), "pi-emptycmd-noconf-"));
  const noConf = await runCli(["backup"], { PI_CODING_AGENT_DIR: noConfDir });
  const noConfJson = lastJson(noConf.stdout);
  check(
    "失败时 JSON 汇总带非空 error",
    noConf.code === 1 && noConfJson.ok === false && Boolean(String(noConfJson.error).trim()),
    JSON.stringify(noConfJson),
  );

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
