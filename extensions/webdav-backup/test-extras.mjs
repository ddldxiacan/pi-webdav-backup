#!/usr/bin/env node
/**
 * test-extras.mjs — agentDir 之外的额外数据（extra/）备份与归位测试
 *
 * 背景：有些插件数据写在 ~/.pi/agent 之外（~/.pi/settings.json、~/.config/rpiv-*），
 * 旧版备份够不到。新增 extraScope 把这些路径打进归档的 extra/ 前缀，恢复时可归位。
 *
 * 验证：
 *   1. extraArchivePath / extraPathToAbsolute 互逆（含 Windows 盘符与 posix）
 *   2. collectFiles 能收集 extraScope（文件与目录），并做排除
 *   3. 未加密备份：extra 里的密钥字段被脱敏后才上传
 *   4. 恢复 → listExtraFiles → applyExtraFiles 能写回真实路径
 *   5. applyExtraFiles 幂等（内容相同跳过）、dry-run 不写盘
 *   6. detectLegacyConfig 发现同级的 settings.json
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDavServer } from "./dav-mock.mjs";
import { collectFiles, extraArchivePath, deriveSensitivePaths } from "./collect.mjs";
import { extraPathToAbsolute, listExtraFiles, applyExtraFiles, detectLegacyConfig, buildExtraMap, resolveExtraEntry, readExtraManifest, EXTRA_MANIFEST_NAME } from "./extras.mjs";
import { loadConfig } from "./config.mjs";
import { runBackup } from "./backup.mjs";
import { restoreBackup } from "./restore.mjs";
import { gunzipSync } from "node:zlib";

let pass = 0;
let fail = 0;
const lines = [];
const normSep = (s) => String(s).replace(/\\/g, "/");
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
  console.log("pi WebDAV 备份 — 额外数据（extra/）测试\n");

  // ── 1. 路径映射（与平台无关地验证 posix 形式）
  const posixMapped = extraArchivePath("/home/me/.pi/settings.json");
  if (process.platform === "win32") {
    // Windows 上 resolve 会补上当前盘符，这是预期行为（用户传的是本机绝对路径）
    check("extraArchivePath 在 Windows 上补盘符且可映射", /^extra\/[A-Za-z]\/.*\.pi\/settings\.json$/.test(posixMapped), posixMapped);
  } else {
    check("extraArchivePath 映射 posix 绝对路径", posixMapped === "extra/home/me/.pi/settings.json", posixMapped);
  }
  const winMapped = extraArchivePath("C:\\Users\\me\\.pi\\settings.json");
  check(
    "extraArchivePath 映射 Windows 路径",
    winMapped === "extra/C/Users/me/.pi/settings.json",
    winMapped,
  );

  if (process.platform === "win32") {
    check(
      "extraPathToAbsolute 还原 Windows 路径",
      extraPathToAbsolute("extra/C/Users/me/.pi/settings.json").toLowerCase() === "c:/users/me/.pi/settings.json",
      extraPathToAbsolute("extra/C/Users/me/.pi/settings.json"),
    );
  } else {
    check(
      "extraPathToAbsolute 还原 posix 路径",
      extraPathToAbsolute("extra/home/me/.pi/settings.json") === "/home/me/.pi/settings.json",
      extraPathToAbsolute("extra/home/me/.pi/settings.json"),
    );
  }
  check("extraPathToAbsolute 拒绝非 extra 路径", extraPathToAbsolute("auth.json") === null);
  check("extraPathToAbsolute 拒绝穿越", extraPathToAbsolute("extra/../../etc/passwd") === null, String(extraPathToAbsolute("extra/../../etc/passwd")));

  // ── 2. 收集：extraScope 文件与目录
  const agentDir = mkdtempSync(join(tmpdir(), "pi-extras-agent-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-extras-outside-"));
  const cfgDir = join(outside, ".config", "rpiv-todo");
  mkdirSync(cfgDir, { recursive: true });
  const legacySettings = join(outside, "settings.json");
  writeFileSync(legacySettings, JSON.stringify({ packages: ["npm:pi-web-access"], theme: "dark" }));
  writeFileSync(join(outside, "with-secrets.json"), JSON.stringify({ providers: { deepseek: { apiKey: "sk-OUTSIDE-SECRET-abcdef1234567890" } } }));
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ token: "tok-outside-1234567890" }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));

  const collected = collectFiles({
    agentDir,
    scope: ["."],
    exclude: [],
    extraScope: [legacySettings, join(outside, "with-secrets.json"), join(outside, ".config", "rpiv-todo")],
  });
  const rels = collected.files.map((f) => f.rel);
  check("收集到 extra 下的 settings.json", rels.includes(extraArchivePath(legacySettings)), rels.join(","));
  check("收集到 extra 下的 secrets json", rels.includes(extraArchivePath(join(outside, "with-secrets.json"))));
  check("收集到 extra 目录内的嵌套文件", rels.some((r) => r.endsWith("rpiv-todo/config.json")), rels.join(","));
  check("agentDir 内文件仍在", rels.includes("settings.json"));

  const sensitive = deriveSensitivePaths([legacySettings, join(outside, "with-secrets.json"), join(outside, ".config", "rpiv-todo")]);
  check("deriveSensitivePaths 覆盖目录（前缀）", sensitive.some((p) => p.endsWith("rpiv-todo/")), JSON.stringify(sensitive));
  check("deriveSensitivePaths 覆盖数据类文件", sensitive.some((p) => p.endsWith("with-secrets.json")), JSON.stringify(sensitive));

  // ── 2b. 跨机映射（纯逻辑，不需落盘）
  {
    // 模拟：旧机 home=/home/alice，config=/home/alice/.config
    const srcAnchors = [
      { kind: "home", path: "/home/alice" },
      { kind: "config", path: "/home/alice/.config" },
    ];
    const source = { platform: "linux", hostname: "oldbox", home: "/home/alice", anchors: srcAnchors };
    // 新机：home=/home/bob，config=/home/bob/.config
    const dstAnchors = [
      { kind: "home", path: "/home/bob" },
      { kind: "config", path: "/home/bob/.config" },
    ];
    const e1 = { rel: "extra/home/alice/.pi/settings.json", orig: "/home/alice/.pi/settings.json", portable: "~/.pi/settings.json" };
    const r1 = resolveExtraEntry(e1, source, { anchors: dstAnchors });
    check("家目录文件换用户名后重映射", normSep(r1.target).endsWith("home/bob/.pi/settings.json") && r1.mapped && r1.anchor === "home", JSON.stringify(r1));

    const e2 = { rel: "extra/home/alice/.config/rpiv-todo/config.json", orig: "/home/alice/.config/rpiv-todo/config.json", portable: "{config}/rpiv-todo/config.json" };
    const r2 = resolveExtraEntry(e2, source, { anchors: dstAnchors });
    check("XDG 配置锚点优先于 home（取最长）", normSep(r2.target).endsWith("home/bob/.config/rpiv-todo/config.json"), JSON.stringify(r2));

    // 到 Windows 新机：home=C:/Users/carol，config=C:/Users/carol/.config，appdata=C:/Users/carol/AppData/Roaming
    const winAnchors = [
      { kind: "home", path: "C:/Users/carol" },
      { kind: "config", path: "C:/Users/carol/.config" },
      { kind: "appdata", path: "C:/Users/carol/AppData/Roaming" },
    ];
    const e3 = { rel: "extra/home/alice/.pi/web-search.json", orig: "/home/alice/.pi/web-search.json", portable: "~/.pi/web-search.json" };
    const r3 = resolveExtraEntry(e3, source, { anchors: winAnchors });
    // 拼接会用当前平台分隔符；只断言锚点尾巴正确
    check("跨平台重映射到 Windows home", r3.mapped && r3.anchor === "home" && normSep(r3.target).endsWith("carol/.pi/web-search.json"), JSON.stringify(r3));

    // 无锚点的绝对路径（如 /etc/foo）→ 保持原样且 mapped=false
    const e4 = { rel: "extra/etc/foo.conf", orig: "/etc/foo.conf", portable: "/etc/foo.conf" };
    const r4 = resolveExtraEntry(e4, source, { anchors: dstAnchors });
    check("无锚点路径保持不变且标记未映射", r4.mapped === false && normSep(r4.target) === "/etc/foo.conf", JSON.stringify(r4));

    // Windows 源 → Windows 目标（盘符可能变）
    const winSrc = { platform: "win32", hostname: "pc1", home: "C:/Users/dave", anchors: [{ kind: "home", path: "C:/Users/dave" }] };
    const e5 = { rel: "extra/C/Users/dave/.pi/settings.json", orig: "C:/Users/dave/.pi/settings.json", portable: "~/.pi/settings.json" };
    const r5 = resolveExtraEntry(e5, winSrc, { anchors: [{ kind: "home", path: "D:/Users/erin" }] });
    check("Windows 换盘符与用户名重映射", r5.mapped && normSep(r5.target).endsWith("Users/erin/.pi/settings.json"), JSON.stringify(r5));
  }

  // ── 3. 未加密备份：extra 里的密钥应被脱敏
  const dav = await startDavServer();
  dav.dirs.add("/dav");
  const baseUrl = `http://127.0.0.1:${dav.port}/dav`;
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify({
      remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi" },
      scope: ["."],
      extraScope: [legacySettings, join(outside, "with-secrets.json"), join(outside, ".config", "rpiv-todo")],
      encrypt: false,
      includeSessions: false,
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = loadConfig().config;
  check("配置读取到 extraScope", Array.isArray(config.extraScope) && config.extraScope.length === 3, JSON.stringify(config.extraScope));

  const bk = await runBackup(config, { log: () => {}, agentDir, stateFile: join(agentDir, "state.json") });
  check("含 extra 的备份成功", bk.ok === true, bk.error);
  check("备份已脱敏 extra 数据", Number(bk.redacted) >= 2, `redacted=${bk.redacted}`);

  const blob = dav.store.get(`/dav/bk/${bk.archive}`);
  check("归档已上传", !!blob);
  if (blob) {
    const text = gunzipSync(blob).toString("latin1");
    check("归档含 extra/settings.json", text.includes("extra/") && text.includes("settings.json"));
    check("归档不含 extra 明文密钥", !text.includes("sk-OUTSIDE-SECRET-abcdef1234567890"), "extra 密钥泄漏！");
    check("归档不含 extra 明文 token", !text.includes("tok-outside-1234567890"), "extra token 泄漏！");
    check("归档保留 package 声明", text.includes("npm:pi-web-access"));
    check("归档含可移植映射 extra-manifest.json", text.includes(EXTRA_MANIFEST_NAME));
    check("映射含 entries 与 anchors 结构", text.includes("\"entries\"") && text.includes("\"anchors\""));
  }

  // ── 4. 恢复 + 归位
  const dest = join(agentDir, "restored");
  const r = await restoreBackup(config, { agentDir, to: dest, log: () => {} });
  check("恢复成功", r.ok === true, JSON.stringify(r));
  check("恢复结果报告 extras 数量", Array.isArray(r.extras) && r.extras.length === 3, JSON.stringify(r.extras));

  const listed = listExtraFiles(dest);
  check("listExtraFiles 列出 3 个文件", listed.length === 3, JSON.stringify(listed.map((x) => x.rel)));
  check("每个 extra 文件都能反推目标路径", listed.every((x) => !!x.target), JSON.stringify(listed));

  // dry-run 不写盘
  rmSync(legacySettings, { force: true });
  const dryRun = applyExtraFiles(dest, { dryRun: true, log: () => {} });
  check("dry-run 报告将写入", dryRun.skipped.length === 3, JSON.stringify(dryRun));
  check("dry-run 未写盘", !existsSync(legacySettings));

  // 安全防护：本地已有真实值（含明文密钥）时，源里的 __REDACTED__ 不应覆盖它
  const safeSkip = applyExtraFiles(dest, { log: () => {} });
  check(
    "本地已有真实值时跳过脱敏覆盖",
    safeSkip.skipped.some((s) => s.rel.endsWith("with-secrets.json")),
    JSON.stringify(safeSkip.skipped),
  );
  const secretsAfterSkip = JSON.parse(readFileSync(join(outside, "with-secrets.json"), "utf8"));
  check(
    "跳过时本地真实密钥未被破坏",
    secretsAfterSkip.providers.deepseek.apiKey === "sk-OUTSIDE-SECRET-abcdef1234567890",
    JSON.stringify(secretsAfterSkip),
  );
  // --force 时仍可强制覆盖
  const forced = applyExtraFiles(dest, { log: () => {}, force: true });
  check("--force 强制覆盖生效", forced.applied.some((a) => a.rel.endsWith("with-secrets.json")), JSON.stringify(forced));
  check("--force 覆盖前留存备份", forced.applied.every((a) => !!a.backup), JSON.stringify(forced.applied));

  // 全部删除后再归位，验证真正写回
  rmSync(legacySettings, { force: true });
  rmSync(join(outside, "with-secrets.json"), { force: true });
  rmSync(join(cfgDir, "config.json"), { force: true });
  const applied = applyExtraFiles(dest, { log: () => {} });
  check("applyExtraFiles 成功", applied.ok === true, JSON.stringify(applied.failed));
  check("归位写回了 settings.json", existsSync(legacySettings));
  if (existsSync(legacySettings)) {
    const j = JSON.parse(readFileSync(legacySettings, "utf8"));
    check("归位内容保留 package 声明", Array.isArray(j.packages) && j.packages.includes("npm:pi-web-access"), JSON.stringify(j));
  }
  check("归位写回了 rpiv config", existsSync(join(cfgDir, "config.json")));

  // 幂等：第二次应全部 unchanged
  const again = applyExtraFiles(dest, { log: () => {} });
  check("重复归位幂等（unchanged）", again.unchanged.length === 3 && again.applied.length === 0, JSON.stringify(again));

  // ── 4b. 跨机归位（合成一个“旧机”恢复目录 + 新机锚点，验证实际写盘到重映射路径）
  {
    const fakeRestore = mkdtempSync(join(tmpdir(), "pi-extras-restore-"));
    const newHome = mkdtempSync(join(tmpdir(), "pi-extras-newhome-"));
    const newConfig = join(newHome, ".config");
    // 归档里的 extra 文件（旧机路径）
    const oldSettings = "extra/home/alice/.pi/settings.json";
    const oldCfg = "extra/home/alice/.config/rpiv-todo/config.json";
    mkdirSync(join(fakeRestore, oldSettings, ".."), { recursive: true });
    mkdirSync(join(fakeRestore, oldCfg, ".."), { recursive: true });
    writeFileSync(join(fakeRestore, oldSettings), JSON.stringify({ theme: "dark", packages: ["npm:pi-x"] }));
    writeFileSync(join(fakeRestore, oldCfg), JSON.stringify({ done: [] }));
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: {
        platform: "linux",
        hostname: "oldbox",
        home: "/home/alice",
        anchors: [
          { kind: "home", path: "/home/alice" },
          { kind: "config", path: "/home/alice/.config" },
        ],
      },
      entries: [
        { rel: oldSettings, orig: "/home/alice/.pi/settings.json", portable: "~/.pi/settings.json" },
        { rel: oldCfg, orig: "/home/alice/.config/rpiv-todo/config.json", portable: "{config}/rpiv-todo/config.json" },
      ],
    };
    writeFileSync(join(fakeRestore, EXTRA_MANIFEST_NAME), JSON.stringify(manifest, null, 2));

    const anchors = [
      { kind: "home", path: newHome },
      { kind: "config", path: newConfig },
    ];
    const cx = applyExtraFiles(fakeRestore, { log: () => {}, anchors });
    check("跨机归位成功", cx.ok === true && cx.applied.length === 2, JSON.stringify(cx));
    check("家目录文件写入新用户名路径", existsSync(join(newHome, ".pi", "settings.json")));
    check("XDG 配置写入新 config 锚点", existsSync(join(newConfig, "rpiv-todo", "config.json")));
    check("跨机归位标记 mapped", cx.applied.every((a) => a.mapped === true), JSON.stringify(cx.applied));
    if (existsSync(join(newHome, ".pi", "settings.json"))) {
      const j = JSON.parse(readFileSync(join(newHome, ".pi", "settings.json"), "utf8"));
      check("跨机归位内容正确（非密钥字段保留）", j.theme === "dark" && Array.isArray(j.packages), JSON.stringify(j));
    }

    // 无映射的绝对路径：应归入 unmapped 并在旧路径不存在时不崩
    rmSync(join(fakeRestore, EXTRA_MANIFEST_NAME), { force: true });
    rmSync(fakeRestore, { recursive: true, force: true });
    rmSync(newHome, { recursive: true, force: true });
  }

  // ── 5. detectLegacyConfig
  const legacyDir = mkdtempSync(join(tmpdir(), "pi-legacy-"));
  const nestedAgent = join(legacyDir, "agent");
  mkdirSync(nestedAgent, { recursive: true });
  writeFileSync(join(legacyDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents", "npm:pi-web-access"] }));
  writeFileSync(join(legacyDir, "web-search.json"), JSON.stringify({ ssrf: {} }));
  const detected = detectLegacyConfig(nestedAgent);
  check("detectLegacyConfig 发现同级 settings.json", detected.some((d) => d.kind === "legacy-settings"));
  check("detectLegacyConfig 提取包声明", detected.find((d) => d.kind === "legacy-settings")?.packages?.length === 2, JSON.stringify(detected));
  check("detectLegacyConfig 发现 web-search.json", detected.some((d) => d.kind === "web-search"));
  check("agentDir 无遗留时不误报", detectLegacyConfig(agentDir).length === 0, JSON.stringify(detectLegacyConfig(agentDir)));

  dav.server.close();
  for (const d of [agentDir, outside, legacyDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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
