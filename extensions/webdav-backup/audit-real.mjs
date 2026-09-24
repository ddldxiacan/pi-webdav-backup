/**
 * 用真实 ~/.pi/agent 内容做一次 dry-run + 审计，确认：
 *   1. 迁移后的 auth.json 引用形态能被正确处理
 *   2. 明文审计通过
 *   3. 迁移遗留的 auth.json.bak-* 不在待上传列表里
 */
import { loadConfig } from "./config.mjs";
import { runBackup, auditForPlaintext } from "./backup.mjs";
import { collectFiles } from "./collect.mjs";
import { resolveAgentDir } from "./config-paths.mjs";

const agentDir = resolveAgentDir();
console.log("agentDir:", agentDir);

const loaded = loadConfig();
console.log("配置文件存在:", loaded.ok || loaded.errors.every((e) => /不存在/.test(e)) ? "是" : "否");
if (loaded.config) {
  for (const w of loaded.warnings) console.log("  警告:", w);
}

// 尚未创建配置时用默认值跑本地扫描（dry-run 不连网）
const cfg = loaded.config ?? {
  enabled: true,
  url: "https://example.invalid/dav",
  username: "",
  password: "",
  remoteDir: "pi-backup",
  remoteName: "pi-agent",
  scope: ["."],
  exclude: [
    "tmp/**",
    "web-search-cache/**",
    "npm/node_modules/**",
    "sessions/**",
    "**/*.log",
    "**/node_modules/**",
    "secrets/**",
    "secrets.dpapi.json",
    "**/*.bak-*",
    "**/*.bak",
    "**/*.orig",
    "**/*.old",
    "**/*.save",
  ],
  includeSessions: false,
  snapshot: false,
  encrypt: false,
  encryptKey: null,
  timeoutMs: 60000,
  insecureTls: false,
  keepVersions: 10,
};
console.log("（未创建配置文件，使用默认范围与排除规则）");
console.log("远端:", cfg.url);

const { files, skipped, totalSize } = collectFiles({
  agentDir,
  scope: cfg.scope,
  exclude: [...cfg.exclude, ...(cfg.includeSessions ? [] : ["sessions/**"])],
});

console.log(`\n待备份文件 ${files.length} 个，${(totalSize / 1024).toFixed(1)} KB，跳过 ${skipped} 项`);
console.log("文件列表:");
for (const f of files) console.log("  ", f.rel);

const baks = files.filter((f) => /\.bak/.test(f.rel));
console.log("\n待备份列表中的 .bak 文件:", baks.length === 0 ? "无 ✅" : baks.map((b) => b.rel).join(", "));

const audit = auditForPlaintext(files, { agentDir, config: cfg });
console.log("\n明文审计:", audit.clean ? "通过 ✅" : "发现问题 ❌");
for (const l of audit.leaks) console.log("  ", l.rel, "—", l.reason);

// 确认 auth.json 上传后确实不含原明文（对比注册表值）
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { redactSensitive } = await import("./backup.mjs");

const authRel = files.find((f) => f.rel.endsWith("auth.json"));
if (authRel) {
  const before = readFileSync(join(agentDir, authRel.rel), "utf8");
  const after = redactSensitive(authRel.rel, Buffer.from(before), { aggressive: true }).toString("utf8");
  console.log("\nauth.json 磁盘原文:", before.replace(/\s+/g, " ").slice(0, 120));
  console.log("auth.json 上传形态:", after.replace(/\s+/g, " ").slice(0, 120));
}
