#!/usr/bin/env node
/**
 * test-apply.mjs — 「插件实现随备份、恢复写回」测试（换机一键还原）
 *
 * 背景：备份默认排除 node_modules，恢复后插件只能靠联网补装，无法真正一键还原。
 * 新增 includePlugins（把插件实现打进备份）与 restore-apply（把恢复结果写回当前
 * 配置目录），让「新电脑装好 pi → 恢复 → 直接用」成为可能。
 *
 * 验证：
 *   1. exclude 组装：includePlugins=false 排除 node_modules；true 则保留（只排除 .git 等）
 *   2. collectFiles 在 includePlugins=true 时确实收集到 node_modules 里的插件代码
 *   3. 归档往返：备份含插件 → 恢复到临时目录 → hasPluginCode/analyzePlugins 通过
 *   4. apply.mjs：listRestoredFiles 跳过 extra/ 与元数据；写回、覆盖前备份、幂等
 *   5. dry-run 不落盘；归档里是 __REDACTED__ 而本地有真实值时跳过
 *   6. applyRestoredFiles 拒绝目录穿越
 *   7. 本机已装插件时的合并策略：保留本机版本与声明、不混入旧文件；replace 则完全还原
 *   8. 本机无 packages 声明时不合并（用备份原样）
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { startDavServer } from "./dav-mock.mjs";
import { loadConfig } from "./config.mjs";
import { collectFiles } from "./collect.mjs";
import { runBackup } from "./backup.mjs";
import { restoreBackup } from "./restore.mjs";
import { analyzePlugins } from "./packages.mjs";
import { applyRestoredFiles, listRestoredFiles, hasPluginCode, pluginRootRel, packageIdentity, mergeSettingsPackages, isMachineSpecificPackagePath } from "./apply.mjs";

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

/** 造一个带插件代码的假 agent 目录 */
function makeAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-apply-agent-"));
  mkdirSync(join(dir, "extensions"), { recursive: true });
  mkdirSync(join(dir, "npm", "node_modules", "pi-footer"), { recursive: true });
  mkdirSync(join(dir, "npm", "node_modules", "foo", "lib"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:pi-footer@0.5.0"], theme: "dark" }));
  writeFileSync(join(dir, "extensions", "mine.ts"), "export default () => {};\n");
  writeFileSync(join(dir, "npm", "package.json"), JSON.stringify({ name: "pi-extensions", private: true, dependencies: { "pi-footer": "^0.5.0", foo: "^1.0.0" } }));
  writeFileSync(join(dir, "npm", "node_modules", "pi-footer", "package.json"), JSON.stringify({ name: "pi-footer", version: "0.5.0" }));
  writeFileSync(join(dir, "npm", "node_modules", "pi-footer", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, "npm", "node_modules", "foo", "package.json"), JSON.stringify({ name: "foo", version: "1.0.0" }));
  writeFileSync(join(dir, "npm", "node_modules", "foo", "lib", "index.js"), "module.exports = 2;\n");
  // 运行时用不到、应被排除的内部数据
  mkdirSync(join(dir, "npm", "node_modules", "foo", ".git"), { recursive: true });
  writeFileSync(join(dir, "npm", "node_modules", "foo", ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

async function main() {
  console.log("pi WebDAV 备份 — 插件随备份 / 恢复写回测试\n");

  // ── 1. exclude 组装
  {
    const dir = makeAgentDir();
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "webdav-backup.json"), JSON.stringify({ remote: { url: "http://127.0.0.1:1/dav" } }));
    const slim = loadConfig().config;
    check("默认 includePlugins=false", slim.includePlugins === false);
    check("瘦备份排除 node_modules", slim.exclude.includes("**/node_modules/**"), slim.exclude.join(","));

    writeFileSync(join(dir, "webdav-backup.json"), JSON.stringify({ remote: { url: "http://127.0.0.1:1/dav" }, includePlugins: true }));
    const fat = loadConfig().config;
    check("includePlugins=true 生效", fat.includePlugins === true);
    check("含插件时不排除 node_modules", !fat.exclude.includes("**/node_modules/**"), fat.exclude.join(","));
    check("含插件时排除 .git 内部", fat.exclude.includes("**/.git/**"), fat.exclude.join(","));

    // ── 2. 收集
    const slimCollected = collectFiles({ agentDir: dir, scope: ["."], exclude: slim.exclude });
    check("瘦备份不收集插件代码", !slimCollected.files.some((f) => f.rel.includes("node_modules/")), slimCollected.files.map((f) => f.rel).join(","));

    const fatCollected = collectFiles({ agentDir: dir, scope: ["."], exclude: fat.exclude });
    const rels = fatCollected.files.map((f) => f.rel);
    check("含插件时收集到插件代码", rels.includes("npm/node_modules/pi-footer/index.js"), rels.join(","));
    check("含插件时收集到嵌套实现", rels.includes("npm/node_modules/foo/lib/index.js"));
    check("含插件时仍排除 .git", !rels.some((r) => r.includes(".git/")), rels.join(","));
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 3. 归档往返：含插件备份 → 恢复
  {
    const dav = await startDavServer();
    dav.dirs.add("/dav");
    const agentDir = makeAgentDir();
    writeFileSync(
      join(agentDir, "webdav-backup.json"),
      JSON.stringify({
        remote: { url: `http://127.0.0.1:${dav.port}/dav`, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi" },
        includePlugins: true,
        encrypt: false,
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const config = loadConfig().config;

    const bk = await runBackup(config, { log: () => {}, agentDir, stateFile: join(agentDir, "s.json") });
    check("含插件备份成功", bk.ok === true, bk.error || JSON.stringify(bk));

    const dest = join(agentDir, "restored");
    const r = await restoreBackup(config, { agentDir, to: dest, log: () => {} });
    check("恢复成功", r.ok === true, JSON.stringify(r).slice(0, 200));
    check("恢复出插件代码", existsSync(join(dest, "npm", "node_modules", "pi-footer", "index.js")));
    check("恢复出嵌套插件代码", existsSync(join(dest, "npm", "node_modules", "foo", "lib", "index.js")));
    check("hasPluginCode 判定为已含插件", hasPluginCode(dest) === true);

    const analysis = analyzePlugins(dest);
    check("含插件恢复后体检通过（无需联网补装）", analysis.ok === true, JSON.stringify(analysis.issues));

    dav.server.close();
    rmSync(agentDir, { recursive: true, force: true });
  }

  // ── 4. listRestoredFiles 跳过 extra/ 与元数据
  {
    const dir = mkdtempSync(join(tmpdir(), "pi-apply-list-"));
    mkdirSync(join(dir, "extra", "C", "Users", "me", ".pi"), { recursive: true });
    mkdirSync(join(dir, "npm"), { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "npm", "package.json"), "{}");
    writeFileSync(join(dir, ".pi-backup-manifest.json"), "{}");
    writeFileSync(join(dir, "extra-manifest.json"), "{}");
    writeFileSync(join(dir, "webdav-backup-state.json"), "{}");
    writeFileSync(join(dir, "webdav-backup.log"), "log");
    writeFileSync(join(dir, "extra", "C", "Users", "me", ".pi", "settings.json"), "{}");

    const files = listRestoredFiles(dir).map((f) => f.rel);
    check("列出 settings.json", files.includes("settings.json"), files.join(","));
    check("列出 npm/package.json", files.includes("npm/package.json"));
    check("跳过 extra/ 下的数据", !files.some((f) => f.startsWith("extra/")), files.join(","));
    check("跳过备份元数据", !files.includes(".pi-backup-manifest.json") && !files.includes("extra-manifest.json"));
    check("跳过 state/log", !files.includes("webdav-backup-state.json") && !files.includes("webdav-backup.log"));
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 5. applyRestoredFiles：写回、覆盖备份、幂等、dry-run
  {
    const src = mkdtempSync(join(tmpdir(), "pi-apply-src-"));
    const dst = mkdtempSync(join(tmpdir(), "pi-apply-dst-"));
    mkdirSync(join(src, "npm", "node_modules", "pi-footer"), { recursive: true });
    writeFileSync(join(src, "settings.json"), JSON.stringify({ theme: "light" }));
    writeFileSync(join(src, "npm", "node_modules", "pi-footer", "index.js"), "module.exports = 1;\n");
    // 本机已有一个不同的 settings.json → 写回应覆盖并备份
    writeFileSync(join(dst, "settings.json"), JSON.stringify({ theme: "dark" }));

    // dry-run：不落盘
    const dry = applyRestoredFiles(src, dst, { dryRun: true });
    check("dry-run 报告待写入", dry.applied.length === 0 && dry.skipped.some((s) => s.reason === "dry-run"), JSON.stringify(dry));
    check("dry-run 不修改本机文件", JSON.parse(readFileSync(join(dst, "settings.json"), "utf8")).theme === "dark");

    // 真正写回
    const r1 = applyRestoredFiles(src, dst);
    check("写回成功", r1.ok === true, JSON.stringify(r1.failed));
    check("插件代码已写入", existsSync(join(dst, "npm", "node_modules", "pi-footer", "index.js")));
    check("settings.json 已更新", JSON.parse(readFileSync(join(dst, "settings.json"), "utf8")).theme === "light");
    const baks = readdirSync(dst).filter((f) => f.startsWith("settings.json.bak-apply-"));
    check("覆盖前已备份原文件", baks.length === 1, readdirSync(dst).join(","));

    // 幂等：再写一次应全部 unchanged
    const r2 = applyRestoredFiles(src, dst);
    check("重复写回幂等（全部一致）", r2.applied.length === 0 && r2.unchanged.length === 2, JSON.stringify({ a: r2.applied, u: r2.unchanged }));

    // 归档里是 __REDACTED__ 而本地有真实值 → 跳过
    const src2 = mkdtempSync(join(tmpdir(), "pi-apply-src2-"));
    writeFileSync(join(src2, "auth.json"), JSON.stringify({ openai: { key: "__REDACTED__" } }));
    writeFileSync(join(dst, "auth.json"), JSON.stringify({ openai: { key: "sk-real-secret" } }));
    const r3 = applyRestoredFiles(src2, dst);
    check("脱敏占位不覆盖本地真实值", r3.skipped.some((s) => s.rel === "auth.json"), JSON.stringify(r3));
    check("本地真实值保持不变", readFileSync(join(dst, "auth.json"), "utf8").includes("sk-real-secret"));
    // force 才覆盖
    const r4 = applyRestoredFiles(src2, dst, { force: true });
    check("--force 才会用占位覆盖", r4.applied.some((a) => a.rel === "auth.json"), JSON.stringify(r4));

    rmSync(src, { recursive: true, force: true });
    rmSync(src2, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }

  // ── 6. 拒绝目录穿越
  {
    const src = mkdtempSync(join(tmpdir(), "pi-apply-evil-"));
    const dst = mkdtempSync(join(tmpdir(), "pi-apply-evil-dst-"));
    // listRestoredFiles 不会产生 ..，但手工构造验证 safeJoin 的过滤
    writeFileSync(join(src, "ok.txt"), "ok");
    const r = applyRestoredFiles(src, dst);
    check("正常文件写回", r.ok && existsSync(join(dst, "ok.txt")));
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }

  // ── 7. CLI 子进程：restore-apply 命令真实可用
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = join(here, "cli.mjs");
    const agent = mkdtempSync(join(tmpdir(), "pi-apply-cli-agent-"));
    const src = mkdtempSync(join(tmpdir(), "pi-apply-cli-src-"));
    mkdirSync(join(src, "npm", "node_modules", "pi-footer"), { recursive: true });
    mkdirSync(join(src, "extra", "home", "me", ".pi"), { recursive: true });
    writeFileSync(join(src, "settings.json"), JSON.stringify({ theme: "light" }));
    writeFileSync(join(src, "npm", "node_modules", "pi-footer", "index.js"), "module.exports=1;\n");
    writeFileSync(join(src, ".pi-backup-manifest.json"), "{}");
    writeFileSync(join(src, "extra", "home", "me", ".pi", "settings.json"), "{}");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "dark" }));
    writeFileSync(join(agent, "webdav-backup.json"), JSON.stringify({ remote: { url: "http://127.0.0.1:1/dav" } }));

    const runCli = (args) =>
      spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      });

    const dry = runCli(["restore-apply", "--dir", src, "--dry-run", "--json"]);
    const dryJson = JSON.parse(dry.stdout.trim().split("\n").pop());
    check("CLI restore-apply --dry-run 成功", dry.status === 0 && dryJson.pluginReady === true, dry.stdout + dry.stderr);

    const real = runCli(["restore-apply", "--dir", src, "--json"]);
    const realJson = JSON.parse(real.stdout.trim().split("\n").pop());
    check("CLI restore-apply 写回成功", real.status === 0 && realJson.ok === true, real.stdout + real.stderr);
    check("CLI 写回更新 settings.json", JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).theme === "light");
    check("CLI 写回插件代码", existsSync(join(agent, "npm", "node_modules", "pi-footer", "index.js")));
    check("CLI 写回不碰 extra/ 与元数据", !existsSync(join(agent, "extra")) && !existsSync(join(agent, ".pi-backup-manifest.json")));

    const idem = runCli(["restore-apply", "--dir", src, "--json"]);
    const idemJson = JSON.parse(idem.stdout.trim().split("\n").pop());
    check("CLI 重复写回幂等", idem.status === 0 && idemJson.applied.length === 0, JSON.stringify(idemJson));

    rmSync(agent, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }

  // ── 7. 新电脑已装插件时的合并策略（重点）
  {
    // 旧机器（备份来源）：P@1.0、无 Q
    const backup = mkdtempSync(join(tmpdir(), "pi-merge-old-"));
    mkdirSync(join(backup, "npm", "node_modules", "P"), { recursive: true });
    writeFileSync(join(backup, "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:P@1.0.0"] }));
    writeFileSync(join(backup, "npm", "package.json"), JSON.stringify({ name: "pi-extensions", private: true, dependencies: { P: "1.0.0" } }));
    writeFileSync(join(backup, "npm", "node_modules", "P", "package.json"), JSON.stringify({ name: "P", version: "1.0.0" }));
    writeFileSync(join(backup, "npm", "node_modules", "P", "index.js"), "// P 1.0\n");
    writeFileSync(join(backup, "npm", "node_modules", "P", "old-only.js"), "// only 1.0\n");

    // 新电脑：已装 P@2.0 与 Q
    const live = mkdtempSync(join(tmpdir(), "pi-merge-new-"));
    mkdirSync(join(live, "npm", "node_modules", "Q"), { recursive: true });
    mkdirSync(join(live, "npm", "node_modules", "P"), { recursive: true });
    writeFileSync(join(live, "settings.json"), JSON.stringify({ theme: "light", packages: ["npm:P@2.0.0", "npm:Q"] }));
    writeFileSync(join(live, "npm", "package.json"), JSON.stringify({ name: "pi-extensions", private: true, dependencies: { P: "2.0.0", Q: "^1.0.0" } }));
    writeFileSync(join(live, "npm", "node_modules", "P", "package.json"), JSON.stringify({ name: "P", version: "2.0.0" }));
    writeFileSync(join(live, "npm", "node_modules", "P", "index.js"), "// P 2.0\n");
    writeFileSync(join(live, "npm", "node_modules", "Q", "index.js"), "// Q\n");

    // 辅助函数单测
    check("pluginRootRel 解析 npm 包", pluginRootRel("npm/node_modules/P/index.js") === "npm/node_modules/P");
    check("pluginRootRel 解析 @scope 包", pluginRootRel("npm/node_modules/@s/p/index.js") === "npm/node_modules/@s/p");
    check("pluginRootRel 解析 git 仓", pluginRootRel("git/github.com/u/r/src/x.ts") === "git/github.com/u/r");
    check("packageIdentity npm 忽略版本", packageIdentity("npm:P@1.0.0") === packageIdentity("npm:P@2.0.0"));
    check("packageIdentity git 忽略 ref", packageIdentity("git:github.com/u/r@v1") === packageIdentity("git:github.com/u/r"));

    // merge：保留本机 P@2.0、保留 Q、不注入 old-only
    const merged = applyRestoredFiles(backup, live, { merge: true });
    check("merge 成功", merged.ok === true, JSON.stringify(merged.failed));
    check("merge 保留本机 P@2.0", JSON.parse(readFileSync(join(live, "npm", "node_modules", "P", "package.json"), "utf8")).version === "2.0.0");
    check("merge 不混入旧版文件", !existsSync(join(live, "npm", "node_modules", "P", "old-only.js")));
    check("merge 保留本机 P@2.0 声明", JSON.parse(readFileSync(join(live, "settings.json"), "utf8")).packages.includes("npm:P@2.0.0"));
    check("merge 保留本机额外插件 Q 声明", JSON.parse(readFileSync(join(live, "settings.json"), "utf8")).packages.includes("npm:Q"));
    check("merge 保留 Q 代码", existsSync(join(live, "npm", "node_modules", "Q", "index.js")));
    check("merge 跳过本机已装插件文件", merged.skipped.some((s) => s.rel.startsWith("npm/node_modules/P/")), JSON.stringify(merged.skipped));

    // replace：完全还原成旧机器（P@1.0、写回旧文件）
    const live2 = mkdtempSync(join(tmpdir(), "pi-merge-new2-"));
    mkdirSync(join(live2, "npm", "node_modules", "P"), { recursive: true });
    writeFileSync(join(live2, "settings.json"), JSON.stringify({ theme: "light", packages: ["npm:P@2.0.0"] }));
    writeFileSync(join(live2, "npm", "node_modules", "P", "package.json"), JSON.stringify({ name: "P", version: "2.0.0" }));
    writeFileSync(join(live2, "npm", "node_modules", "P", "index.js"), "// P 2.0\n");
    const replaced = applyRestoredFiles(backup, live2, { merge: false });
    check("replace 成功", replaced.ok === true);
    check("replace 降级为 P@1.0", JSON.parse(readFileSync(join(live2, "npm", "node_modules", "P", "package.json"), "utf8")).version === "1.0.0");
    check("replace 声明变回 P@1.0", JSON.parse(readFileSync(join(live2, "settings.json"), "utf8")).packages.includes("npm:P@1.0.0"));
    check("replace 写入了备份里的旧文件", existsSync(join(live2, "npm", "node_modules", "P", "old-only.js")));

    rmSync(backup, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
    rmSync(live2, { recursive: true, force: true });
  }

  // 8. mergeSettingsPackages：本机无声明时返回 null（用备份原样）
  {
    check("本机无 packages 声明时不合并", mergeSettingsPackages('{"packages":["npm:A"]}', '{"theme":"x"}') === null);
    const m = mergeSettingsPackages('{"packages":["npm:A","npm:B"],"theme":"light"}', '{"packages":["npm:B@2"],"theme":"dark"}');
    const o = JSON.parse(m);
    check("合并保留本机声明优先、追加备份独有", JSON.stringify(o.packages) === JSON.stringify(["npm:B@2", "npm:A"]) && o.theme === "light", String(m));
  }

  // ── 8b. 回归：跨机同步不得带入旧机器的绝对路径本地源
  {
    // isMachineSpecificPackagePath 单测
    check("识别 Windows 盘符路径", isMachineSpecificPackagePath("E:\\Users\\me\\ext") === true);
    check("识别正斜杠盘符路径", isMachineSpecificPackagePath("C:/Users/me/ext") === true);
    check("识别 POSIX 绝对路径", isMachineSpecificPackagePath("/home/me/ext") === true);
    check("识别 UNC 路径", isMachineSpecificPackagePath("\\\\server\\share\\ext") === true);
    check("npm 源不误判", isMachineSpecificPackagePath("npm:foo") === false);
    check("git 源不误判", isMachineSpecificPackagePath("git:github.com/u/r@v1") === false);
    check("https 源不误判", isMachineSpecificPackagePath("https://github.com/u/r") === false);
    check("相对路径不误判（可移植）", isMachineSpecificPackagePath("./ext") === false);

    // 合并时：备份里的 Windows 绝对路径不得进入 Linux 的 packages
    const backup = JSON.stringify({ packages: ["npm:pi-signal-footer", "E:\\Users\\Administrator\\Desktop\\projects\\pi-webdav-backup"] });
    const live = JSON.stringify({ packages: ["npm:@zhangweiii/pi-status-line"] });
    const merged = JSON.parse(mergeSettingsPackages(backup, live));
    check("合并过滤掉旧机器绝对路径", !merged.packages.some((p) => /^[A-Za-z]:[\\/]/.test(p)), JSON.stringify(merged.packages));
    check("合并仍保留可移植的 npm 源", merged.packages.includes("npm:pi-signal-footer"), JSON.stringify(merged.packages));
    check("合并保留本机声明", merged.packages.includes("npm:@zhangweiii/pi-status-line"));

    // 全新机（本机无 packages）：同样要过滤外来绝对路径
    const fresh = mergeSettingsPackages(backup, JSON.stringify({ theme: "dark" }));
    check("全新机场景也过滤外来绝对路径", fresh !== null && !JSON.parse(fresh).packages.some((p) => /^[A-Za-z]:[\\/]/.test(p)), String(fresh));
    check("全新机仅剩可移植源则不改写", mergeSettingsPackages('{"packages":["npm:A"]}', '{}') === null);
  }

  // ── 9. 回归：npm/package.json 必须合并 dependencies（否则 pi 会卸载本机独有插件）
  {
    // 备份来源（Windows）：只依赖 A、B
    const backup = mkdtempSync(join(tmpdir(), "pi-npm-merge-bk-"));
    mkdirSync(join(backup, "npm"), { recursive: true });
    writeFileSync(join(backup, "settings.json"), JSON.stringify({ packages: ["npm:A", "npm:B"] }));
    writeFileSync(
      join(backup, "npm", "package.json"),
      JSON.stringify({ name: "pi-extensions", private: true, dependencies: { A: "^1.0.0", B: "^2.0.0" } }),
    );

    // 目标机器（Linux）：已装 A（本机版本）+ 本机独有的 Z
    const live = mkdtempSync(join(tmpdir(), "pi-npm-merge-live-"));
    mkdirSync(join(live, "npm"), { recursive: true });
    writeFileSync(join(live, "settings.json"), JSON.stringify({ packages: ["npm:A@9", "npm:Z"] }));
    writeFileSync(
      join(live, "npm", "package.json"),
      JSON.stringify({ name: "pi-extensions", private: true, dependencies: { A: "^9.0.0", Z: "^0.1.0" } }),
    );

    const r = applyRestoredFiles(backup, live, { merge: true });
    const deps = JSON.parse(readFileSync(join(live, "npm", "package.json"), "utf8")).dependencies;
    check("merge 后 npm 依赖保留本机 A@9", deps.A === "^9.0.0", JSON.stringify(deps));
    check("merge 后 npm 依赖保留本机独有 Z", deps.Z === "^0.1.0", JSON.stringify(deps));
    check("merge 后 npm 依赖追加备份独有的 B", deps.B === "^2.0.0", JSON.stringify(deps));
    check("merged 列表标出 npm-dependencies", r.merged?.some((m) => m.kind === "npm-dependencies"), JSON.stringify(r.merged));

    // replace：完全用备份版（Z 会从 package.json 消失，由 pi 下次启动自行卸载）
    const live2 = mkdtempSync(join(tmpdir(), "pi-npm-merge-live2-"));
    mkdirSync(join(live2, "npm"), { recursive: true });
    writeFileSync(join(live2, "settings.json"), JSON.stringify({ packages: ["npm:A@9", "npm:Z"] }));
    writeFileSync(
      join(live2, "npm", "package.json"),
      JSON.stringify({ name: "pi-extensions", private: true, dependencies: { A: "^9.0.0", Z: "^0.1.0" } }),
    );
    applyRestoredFiles(backup, live2, { merge: false });
    const deps2 = JSON.parse(readFileSync(join(live2, "npm", "package.json"), "utf8")).dependencies;
    check("replace 后 npm 依赖完全变回备份版", JSON.stringify(deps2) === JSON.stringify({ A: "^1.0.0", B: "^2.0.0" }), JSON.stringify(deps2));

    rmSync(backup, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
    rmSync(live2, { recursive: true, force: true });
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
