#!/usr/bin/env node
/**
 * test-auth-migrate.mjs — auth.json 明文密钥迁移测试
 *
 * 关键不变量：
 *   - 空 key（pi 用它表示“未配置”）绝不能改成引用
 *   - 已是引用的不重复迁移
 *   - 迁移后文件里不再有明文，且引用可被解析出原值
 *   - 写环境变量失败时不动文件（避免丢密钥）
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const agentDir = mkdtempSync(join(tmpdir(), "pi-auth-mig-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const A = await import("./auth-migrate.mjs");
const S = await import("./secrets.mjs");

const authPath = join(agentDir, "auth.json");
const write = (obj) => writeFileSync(authPath, JSON.stringify(obj, null, 2));

console.log("pi WebDAV 备份 — auth.json 迁移测试\n");

// ── 1. 环境变量命名
check("provider 名转为合法环境变量名", A.envVarNameFor("deepseek") === "PI_PI_KEY_DEEPSEEK");
check("含连字符的 provider", A.envVarNameFor("azure-openai-responses") === "PI_PI_KEY_AZURE_OPENAI_RESPONSES");
check("含点的 provider", A.envVarNameFor("foo.bar") === "PI_PI_KEY_FOO_BAR");
check("空名兜底", A.envVarNameFor("") === "PI_PI_KEY_");

// ── 2. 扫描
write({
  deepseek: { type: "api_key", key: "sk-" + "a".repeat(32) },
  "azure-openai-responses": { type: "api_key", key: "" },
  migrated: { type: "api_key", key: "$ALREADY_SET" },
  cmdbased: { type: "api_key", key: "!pass show foo" },
  dpapied: { type: "api_key", key: "dpapi:some-name" },
});

const scan = A.scanAuthSecrets();
check("扫描成功", scan.ok === true, JSON.stringify(scan));
const byProvider = Object.fromEntries(scan.items.map((i) => [i.provider, i]));
check("识别 deepseek 为明文", byProvider.deepseek?.kind === "plaintext");
check("识别空 key 为 empty", byProvider["azure-openai-responses"]?.kind === "empty");
check("识别 $VAR 为引用", byProvider.migrated?.kind === "reference");
check("识别 !命令 为引用", byProvider.cmdbased?.kind === "reference");
check("识别 dpapi: 为引用", byProvider.dpapied?.kind === "reference");
check("明文项提供建议环境变量名", byProvider.deepseek?.suggestedEnv === "PI_PI_KEY_DEEPSEEK");
check("明文项提供建议 dpapi 名", byProvider.deepseek?.suggestedDpapi === "dpapi:auth-deepseek");
check("扫描结果不含密钥明文", !JSON.stringify(scan).includes("sk-aaaa"));

// ── 3. dry-run 不改文件
const before = readFileSync(authPath, "utf8");
const dry = await A.migrateAuthJson({ method: "env", log: () => {}, dryRun: true });
check("dry-run 报告待迁移项", dry.ok && dry.wouldMigrate?.length === 1, JSON.stringify(dry));
check("dry-run 指定目标为 $ENV", dry.wouldMigrate?.[0]?.target === "$PI_PI_KEY_DEEPSEEK");
check("dry-run 未修改文件", readFileSync(authPath, "utf8") === before);

// ── 4. 真实迁移（env）
if (S.dpapiAvailable()) {
  const real = await A.migrateAuthJson({ method: "env", log: () => {} });
  check("迁移成功", real.ok === true, JSON.stringify(real));
  check("迁移了 1 项", real.migrated === 1, `migrated=${real.migrated}`);
  check("迁移前备份 auth.json", !!real.backup && existsSync(real.backup));
  check("待重启环境变量已列出", real.envVarsNeedRestart?.includes("PI_PI_KEY_DEEPSEEK"));

  const afterObj = JSON.parse(readFileSync(authPath, "utf8"));
  check("deepseek.key 已变为 $ENV 引用", afterObj.deepseek.key === "$PI_PI_KEY_DEEPSEEK", afterObj.deepseek.key);
  check(
    "auth.json 不再含明文密钥",
    !readFileSync(authPath, "utf8").includes("sk-aaaa"),
    "明文仍存在",
  );
  check("空 key 保持为空（未被破坏）", afterObj["azure-openai-responses"].key === "", JSON.stringify(afterObj["azure-openai-responses"]));
  check("已有引用未被改写", afterObj.migrated.key === "$ALREADY_SET");
  check("!命令引用未被改写", afterObj.cmdbased.key === "!pass show foo");
  check("dpapi 引用未被改写", afterObj.dpapied.key === "dpapi:some-name");
  check("type 字段保持", afterObj.deepseek.type === "api_key");

  // 迁移后的引用必须能解析出原值
  const resolved = S.resolveSecret(afterObj.deepseek.key);
  check("迁移后的引用可解析出原密钥", resolved.value === "sk-" + "a".repeat(32), JSON.stringify({ source: resolved.source, len: resolved.value?.length }));

  // 备份文件应保留原明文（用于回滚）
  check("备份文件保留了可回滚的原文", readFileSync(real.backup, "utf8").includes("sk-aaaa"));

  // 重复迁移无副作用
  const again = await A.migrateAuthJson({ method: "env", log: () => {} });
  check("重复迁移为 0 项", again.ok === true && again.message !== undefined, JSON.stringify(again));

  // ── 5. dpapi 方式
  write({
    provider1: { type: "api_key", key: "secret-key-one-1234567890" },
    provider2: { type: "api_key", key: "secret-key-two-0987654321" },
  });
  const dp = await A.migrateAuthJson({ method: "dpapi", log: () => {} });
  check("dpapi 迁移成功", dp.ok === true, JSON.stringify(dp));
  check("dpapi 迁移 2 项", dp.migrated === 2, `migrated=${dp.migrated}`);
  const dpObj = JSON.parse(readFileSync(authPath, "utf8"));
  check("provider1 → dpapi 引用", dpObj.provider1.key === "dpapi:auth-provider1", dpObj.provider1.key);
  check("dpapi 迁移后无明文", !readFileSync(authPath, "utf8").includes("secret-key-one"));
  check("dpapi 引用可解出原值", S.resolveSecret(dpObj.provider1.key).value === "secret-key-one-1234567890");

  // ── 6. perProvider 覆盖：部分保留
  write({
    keepme: { type: "api_key", key: "keep-this-plaintext-key-1234" },
    moveme: { type: "api_key", key: "move-this-plaintext-key-5678" },
  });
  const mixed = await A.migrateAuthJson({
    method: "dpapi",
    perProvider: { keepme: "keep", moveme: "env" },
    log: () => {},
  });
  check("混合迁移成功", mixed.ok === false || mixed.migrated === 1, JSON.stringify(mixed));
  const mixedObj = JSON.parse(readFileSync(authPath, "utf8"));
  check("keepme 保持明文（用户选择）", mixedObj.keepme.key === "keep-this-plaintext-key-1234");
  check("moveme 迁移为引用", mixedObj.moveme.key.startsWith("$"), mixedObj.moveme.key);
  check("剩余明文被报告", mixed.remainingPlaintext?.includes("keepme"), JSON.stringify(mixed.remainingPlaintext));
} else {
  lines.push("  ⏭  跳过真实迁移（非 Windows）");
}

// ── 7. 空 auth.json / 无明文
write({});
const none = await A.migrateAuthJson({ method: "env", log: () => {} });
check("无条目时报告无需迁移", none.ok === true && none.migrated === 0, JSON.stringify(none));

write({ p: { type: "api_key", key: "" } });
const onlyEmpty = await A.migrateAuthJson({ method: "env", log: () => {} });
check("仅空 key 时不动文件", onlyEmpty.ok === true && onlyEmpty.migrated === 0, JSON.stringify(onlyEmpty));
check("空 key 仍为空", JSON.parse(readFileSync(authPath, "utf8")).p.key === "");

// ── 8. 损坏的 auth.json
writeFileSync(authPath, "{ broken json");
const broken = A.scanAuthSecrets();
check("损坏 JSON 被识别", broken.ok === false && /不是合法 JSON/.test(broken.error), JSON.stringify(broken));
const brokenMig = await A.migrateAuthJson({ method: "env", log: () => {} });
check("损坏 JSON 时迁移被拒绝", brokenMig.ok === false);

// ── 9. 不存在的 auth.json
rmSync(authPath, { force: true });
const missing = A.scanAuthSecrets();
check("缺失 auth.json 被识别", missing.ok === false && /不存在/.test(missing.error), JSON.stringify(missing));

// ── 10. 脱敏保留引用（回归：引用被抹掉会丢失“密钥在哪”的信息）
const { redactSensitive } = await import("./backup.mjs");
const refAuth = JSON.stringify({
  deepseek: { type: "api_key", key: "$PI_PI_KEY_DEEPSEEK" },
  other: { type: "api_key", key: "sk-realm-plaintext-secret" },
  empty: { type: "api_key", key: "" },
  cmd: { type: "api_key", key: "!pass show x" },
  dp: { type: "api_key", key: "dpapi:auth-x" },
});
const red = redactSensitive("auth.json", Buffer.from(refAuth), { aggressive: true }).toString("utf8");
const redObj = JSON.parse(red);
check("脱敏保留 $ENV 引用", redObj.deepseek.key === "$PI_PI_KEY_DEEPSEEK", redObj.deepseek.key);
check("脱敏保留 !命令 引用", redObj.cmd.key === "!pass show x");
check("脱敏保留 dpapi 引用", redObj.dp.key === "dpapi:auth-x");
check("脱敏保留空 key", redObj.empty.key === "");
check("脱敏替换真明文", redObj.other.key === "__REDACTED__", redObj.other.key);
check("脱敏后不含真明文", !red.includes("sk-realm-plaintext-secret"));

// 清理
try {
  rmSync(agentDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(lines.join("\n"));
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
