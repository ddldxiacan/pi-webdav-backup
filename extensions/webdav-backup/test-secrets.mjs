#!/usr/bin/env node
/**
 * test-secrets.mjs — 密钥存储层测试
 *
 * 目标：确认配置文件里可以完全不出现明文密钥。
 * 覆盖 dpapi: / $ENV / file: / !command / plain: / 字面量 各分支，
 * 以及明文迁移。
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

const agentDir = mkdtempSync(join(tmpdir(), "pi-secrets-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const S = await import("./secrets.mjs");
const { loadConfig } = await import("./config.mjs");
const { migrateSecrets } = await import("./migrate.mjs");

console.log("pi WebDAV 备份 — 密钥存储测试\n");

// ── 1. 明文判定
check("明文被识别", S.isPlaintextSecret("MyPassword123") === true);
check("dpapi: 不算明文", S.isPlaintextSecret("dpapi:a") === false);
check("$ENV 不算明文", S.isPlaintextSecret("$FOO") === false);
check("${ENV} 不算明文", S.isPlaintextSecret("${FOO}") === false);
check("file: 不算明文", S.isPlaintextSecret("file:/x") === false);
check("!command 不算明文", S.isPlaintextSecret("!pass show x") === false);
check("plain: 不算明文（但会在解析时告警）", S.isPlaintextSecret("plain:x") === false);
check("空值不算明文", S.isPlaintextSecret("") === false);

// ── 2. 环境变量解析
process.env.PI_TEST_SECRET = "env-secret-value";
const r1 = S.resolveSecret("$PI_TEST_SECRET");
check("$VAR 解析成功", r1.value === "env-secret-value", JSON.stringify(r1));
check("$VAR 来源标记为 env", r1.source === "env");

const r2 = S.resolveSecret("${PI_TEST_SECRET}");
check("${VAR} 解析成功", r2.value === "env-secret-value", JSON.stringify(r2));

const r3 = S.resolveSecret("pre-$PI_TEST_SECRET-post");
check("模板插值", r3.value === "pre-env-secret-value-post", JSON.stringify(r3));

const r4 = S.resolveSecret("$DEFINITELY_NOT_SET_VAR_9");
check("缺失环境变量给出错误", r4.value === undefined && /环境变量未设置/.test(r4.error), JSON.stringify(r4));

check("$$ 转义为字面量 $", S.resolveSecret("$$literal").value === "$literal");
check("$! 转义为字面量 !", S.resolveSecret("$!literal").value === "!literal");

// ── 3. file: 解析
const secretFile = join(agentDir, "pw.txt");
writeFileSync(secretFile, "file-secret-value\n");
const r5 = S.resolveSecret(`file:${secretFile}`);
check("file: 解析并去换行", r5.value === "file-secret-value", JSON.stringify(r5));
check("file: 支持相对 agentDir 路径", (() => {
  writeFileSync(join(agentDir, "rel.txt"), "rel-secret");
  return S.resolveSecret("file:rel.txt").value === "rel-secret";
})());
check("file: 不存在时报错", (() => {
  const r = S.resolveSecret("file:nope-not-here.txt");
  return r.value === undefined && /不存在/.test(r.error);
})());
writeFileSync(join(agentDir, "empty.txt"), "   \n");
check("file: 空文件报错", (() => {
  const r = S.resolveSecret("file:empty.txt");
  return r.value === undefined && /为空/.test(r.error);
})());

// ── 4. 命令解析
const r6 = S.resolveSecret("!echo cmd-secret");
check("!command 取 stdout", r6.value === "cmd-secret", JSON.stringify(r6));
check("!command 来源标记", r6.source === "command");
check("!command 失败报错", (() => {
  const r = S.resolveSecret("!exit 3");
  return r.value === undefined && /命令执行失败|无输出/.test(r.error);
})());

// ── 5. plain: 显式明文
const r7 = S.resolveSecret("plain:explicit-plaintext");
check("plain: 解析出值", r7.value === "explicit-plaintext");
check("plain: 给出告警", typeof r7.warning === "string" && r7.warning.length > 0, JSON.stringify(r7));

// ── 6. 字面量即明文，必须告警
const r8 = S.resolveSecret("barePlaintext123");
check("字面量解析出值", r8.value === "barePlaintext123");
check("字面量给出明文告警", /明文/.test(String(r8.warning)), JSON.stringify(r8));
check("allowPlain=false 时拒绝明文", (() => {
  const r = S.resolveSecret("barePlaintext123", { allowPlain: false });
  return r.value === undefined && !!r.error;
})());

// ── 7. DPAPI 往返（Windows）
if (S.dpapiAvailable()) {
  S.setDpapiSecret("unit-test-secret", "dpapi-roundtrip-value");
  const r9 = S.resolveSecret("dpapi:unit-test-secret");
  check("DPAPI 往返解密正确", r9.value === "dpapi-roundtrip-value", JSON.stringify(r9));
  check("DPAPI 来源标记", r9.source === "dpapi");

  const listed = S.listDpapiSecrets();
  check("listDpapiSecrets 含该条目", listed.some((s) => s.name === "unit-test-secret"));
  check("列表不含明文", !JSON.stringify(listed).includes("dpapi-roundtrip-value"));

  const storeRaw = readFileSync(S.dpapiStorePath(), "utf8");
  check("DPAPI 仓库文件不含明文", !storeRaw.includes("dpapi-roundtrip-value"));
  check("DPAPI 仓库文件记录了 scope", /CurrentUser/.test(storeRaw));

  check("不存在的 DPAPI 名称报错", (() => {
    const r = S.resolveSecret("dpapi:no-such-name");
    return r.value === undefined && /找不到/.test(r.error);
  })());

  check("删除 DPAPI 密钥", S.deleteDpapiSecret("unit-test-secret") === true);
  check("删除后解析失败", S.resolveSecret("dpapi:unit-test-secret").value === undefined);
} else {
  lines.push("  ⏭  跳过 DPAPI 测试（非 Windows）");
}

// ── 8. 配置层集成：明文 → 告警；引用 → 无告警
const cfgPath = join(agentDir, "webdav-backup.json");

writeFileSync(
  cfgPath,
  JSON.stringify({
    remote: { url: "https://dav.example.com/dav/", username: "u", password: "PlaintextPw123" },
    encrypt: false,
  }),
);
const c1 = loadConfig();
check("明文密码仍可用（向后兼容）", c1.ok && c1.config.password === "PlaintextPw123", JSON.stringify(c1.errors));
check("明文密码触发告警", c1.warnings.some((w) => /明文/.test(w)), JSON.stringify(c1.warnings));
check("密码来源标记为 literal", c1.secrets.passwordSource === "literal");

closeNoop();
function closeNoop() {}

process.env.PI_TEST_PW = "from-env-pw";
writeFileSync(
  cfgPath,
  JSON.stringify({
    remote: { url: "https://dav.example.com/dav/", username: "u", password: "$PI_TEST_PW" },
    encrypt: false,
  }),
);
const c2 = loadConfig();
check("$ENV 密码解析正确", c2.config.password === "from-env-pw", JSON.stringify(c2));
check("$ENV 密码无明文告警", !c2.warnings.some((w) => /明文/.test(w)), JSON.stringify(c2.warnings));

// 缺失环境变量应阻断
writeFileSync(
  cfgPath,
  JSON.stringify({
    remote: { url: "https://dav.example.com/dav/", username: "u", password: "$NOT_SET_PW_VAR" },
  }),
);
const c3 = loadConfig();
check("缺失环境变量导致配置失败", c3.ok === false, JSON.stringify(c3.errors));
check("错误信息指明变量名", c3.errors.some((e) => /NOT_SET_PW_VAR/.test(e)), JSON.stringify(c3.errors));

// encryptKey 明文告警
writeFileSync(
  cfgPath,
  JSON.stringify({
    remote: { url: "https://dav.example.com/dav/", username: "u", password: "$PI_TEST_PW" },
    encrypt: true,
    encryptKey: "plaintext-key-abcdefg",
  }),
);
const c4 = loadConfig();
check("encryptKey 明文触发告警", c4.warnings.some((w) => /encryptKey 是明文/.test(w)), JSON.stringify(c4.warnings));

// ── 9. 迁移：明文 → DPAPI
if (S.dpapiAvailable()) {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      remote: {
        url: "https://dav.example.com/dav/",
        username: "u",
        password: "MigrateMePassword123",
        remoteDir: "bk",
        remoteName: "pi",
      },
      encrypt: true,
      encryptKey: "MigrateMeKeyPassphrase",
      keepVersions: 5,
    }),
  );

  const dry = await migrateSecrets({ method: "dpapi", log: () => {}, dryRun: true });
  check("迁移 dry-run 报告待迁移项", dry.ok && dry.wouldMigrate?.length === 2, JSON.stringify(dry));

  const mig = await migrateSecrets({ method: "dpapi", log: () => {} });
  check("迁移执行成功", mig.ok && mig.migrated === 2, JSON.stringify(mig));
  check("迁移前自动备份配置", !!mig.backup && existsSync(mig.backup));

  const after = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("password 已变为 dpapi 引用", String(after.remote.password).startsWith("dpapi:"), after.remote.password);
  check("encryptKey 已变为 dpapi 引用", String(after.encryptKey).startsWith("dpapi:"), after.encryptKey);
  check("配置文件不再含明文密码", !readFileSync(cfgPath, "utf8").includes("MigrateMePassword123"));
  check("配置文件不再含明文密钥", !readFileSync(cfgPath, "utf8").includes("MigrateMeKeyPassphrase"));
  check("其他字段保持不变", after.keepVersions === 5 && after.remote.remoteDir === "bk");

  const c5 = loadConfig();
  check("迁移后配置仍可加载", c5.ok, JSON.stringify(c5.errors));
  check("迁移后密码可解密", c5.config.password === "MigrateMePassword123");
  check("迁移后 encryptKey 可解密", c5.config.encryptKey === "MigrateMeKeyPassphrase");
  check("迁移后无明文告警", !c5.warnings.some((w) => /明文/.test(w)), JSON.stringify(c5.warnings));

  const again = await migrateSecrets({ method: "dpapi", log: () => {} });
  check("重复迁移无副作用", again.ok && again.migrated === 0, JSON.stringify(again));
} else {
  lines.push("  ⏭  跳过迁移测试（非 Windows）");
}

// ── 10. 迁移：明文 → file
writeFileSync(
  cfgPath,
  JSON.stringify({
    remote: { url: "https://dav.example.com/dav/", username: "u", password: "FileModePassword1" },
    encrypt: false,
  }),
);
const mf = await migrateSecrets({ method: "file", log: () => {} });
check("file 方式迁移成功", mf.ok === true, JSON.stringify(mf));
const afterF = JSON.parse(readFileSync(cfgPath, "utf8"));
check("file 引用已写入配置", String(afterF.remote.password).startsWith("file:"), afterF.remote.password);
check("secrets 目录已创建", existsSync(join(agentDir, "secrets")));
const c6 = loadConfig();
check("file 方式迁移后可加载", c6.ok && c6.config.password === "FileModePassword1", JSON.stringify(c6.errors));

// ── 11. 迁移：明文 → env
writeFileSync(
  cfgPath,
  JSON.stringify({
    remote: { url: "https://dav.example.com/dav/", username: "u", password: "EnvModePassword1" },
    encrypt: false,
  }),
);
const me = await migrateSecrets({ method: "env", log: () => {} });
check("env 方式迁移成功", me.ok === true, JSON.stringify(me));
const afterE = JSON.parse(readFileSync(cfgPath, "utf8"));
check("env 引用已写入配置", afterE.remote.password === "$PI_WEBDAV_BACKUP_PASSWORD", afterE.remote.password);
check("env 方式不再含明文", !readFileSync(cfgPath, "utf8").includes("EnvModePassword1"));

// 清理
try {
  rmSync(agentDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(lines.join("\n"));
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
