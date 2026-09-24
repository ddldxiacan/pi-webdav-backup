#!/usr/bin/env node
/**
 * test-redact.mjs — 敏感信息脱敏测试（安全关键路径）
 *
 * 背景：早期实现只按字段名（key/token/...）匹配，
 * 形如 {"k": "sk-xxxx"} 的凭据会被【原样上传到云端】。
 * 这里锁定修复后的行为。
 */

import { redactSensitive } from "./backup.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDavServer } from "./dav-mock.mjs";
import { runBackup } from "./backup.mjs";
import { collectFiles } from "./collect.mjs";

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

const b = (s) => Buffer.from(s, "utf8");
const redact = (rel, text, opts) => {
  const r = redactSensitive(rel, b(text), opts);
  return r ? r.toString("utf8") : null;
};

console.log("pi WebDAV 备份 — 脱敏安全性测试\n");

// ── 1. 字段名匹配（传统情况）
const r1 = redact("auth.json", JSON.stringify({ openai: { key: "sk-abc123", type: "api" } }));
check("字段名 key 被脱敏", !r1.includes("sk-abc123"), r1);
check("非敏感字段保留", r1.includes('"type": "api"') || r1.includes('"type":"api"'));

// ── 2. 字段名不含敏感词，但值是凭据（回归：早期版本会泄漏）
const r2 = redact("auth.json", JSON.stringify({ p: { k: "sk-SECRET-CANARY-1234567890" } }));
check("字段名无关但值像密钥 → 脱敏（回归）", !r2.includes("sk-SECRET-CANARY"), r2);

const r3 = redact("auth.json", JSON.stringify({ a: { b: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }));
check("GitHub token 值被识别", !r3.includes("ghp_abcdefghij"), r3);

const r4 = redact("auth.json", JSON.stringify({ x: "AIzaSyA1234567890abcdefghijklmnopqrst" }));
check("Google API key 值被识别", !r4.includes("AIzaSy"), r4);

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop";
const r5 = redact("auth.json", JSON.stringify({ t: jwt }));
check("JWT 值被识别", !r5.includes("eyJhbGciOiJIUzI1NiJ9"), r5);

// ── 3. 深层嵌套与数组
const r6 = redact(
  "auth.json",
  JSON.stringify({ providers: [{ name: "a", creds: { token: "tok-1234567890" } }], list: ["sk-deep-secret-value-1"] }),
);
check("嵌套对象内的 token 被脱敏", !r6.includes("tok-1234567890"), r6);
check("数组内的凭据被脱敏", !r6.includes("sk-deep-secret-value-1"), r6);
check("脱敏后仍是合法 JSON", (() => { try { JSON.parse(r6); return true; } catch { return false; } })());

// ── 4. 不应误伤普通值
const r7 = redact("auth.json", JSON.stringify({ model: "claude-sonnet-4", theme: "dark", count: 42 }));
check("普通短字符串不被脱敏", r7.includes("claude-sonnet-4") && r7.includes("dark"), r7);

// ── 5. 无法解析时绝不原样上传
try {
  const r8 = redact("auth.json", "{ not valid json ");
  check("无法解析的 auth.json 不泄漏原文", r8 !== null && !r8.includes("not valid json"), String(r8));
} catch {
  check("无法解析的 auth.json 不泄漏原文", false, "抛出了异常");
}

// ── 6. 配置文件：密码与加密密钥
const cfgText = JSON.stringify({
  remote: { url: "https://dav.example.com/dav/", username: "me@example.com", password: "MyRealPassword123", remoteDir: "bk" },
  encryptKey: "super-secret-passphrase",
  encrypt: false,
});
const r9 = redact("webdav-backup.json", cfgText);
check("配置里的 password 被脱敏", !r9.includes("MyRealPassword123"), r9);
check("配置里的 encryptKey 被脱敏", !r9.includes("super-secret-passphrase"), r9);
check("配置里的 url 保留（便于诊断）", r9.includes("dav.example.com"), r9);

// ── 7. 加密备份时（aggressive=false）仍保护已知字段
const r10 = redact("webdav-backup.json", cfgText, { aggressive: false });
check("aggressive=false 仍脱敏 password", !r10.includes("MyRealPassword123"), r10);

const r11 = redact("auth.json", JSON.stringify({ openai: { key: "sk-known-field" } }), { aggressive: false });
check("aggressive=false 仍按字段名脱敏", !r11.includes("sk-known-field"), r11);

// ── 8. 不相关文件返回 null（不做无谓改写）
check("普通文件返回 null", redactSensitive("extensions/a.ts", b("const x = 1;")) === null);
check("settings.json 返回 null", redactSensitive("settings.json", b('{"theme":"dark"}')) === null);

// ── 9. 子目录下的 auth.json 同样处理
const r12 = redact("deep/nested/auth.json", JSON.stringify({ z: "sk-nested-canary-0123456789" }));
check("嵌套路径 auth.json 也被脱敏", !r12.includes("sk-nested-canary"), r12);

// ── 10. 空对象/边界
check("空对象不报错", (() => { try { redact("auth.json", "{}"); return true; } catch { return false; } })());
check("null 值不报错", (() => { try { redact("auth.json", '{"a":null,"b":1}'); return true; } catch { return false; } })());

// ── 12. 明文审计（防止备份副本把密钥带上云）
{
  const { auditForPlaintext, looksCredentialFile } = await import("./backup.mjs");

  // 带有 .bak-* 副本的目录（真实场景：迁移后遗留）
  const leakDir = mkdtempSync(join(tmpdir(), "pi-audit-"));
  mkdirSync(join(leakDir, "extensions"), { recursive: true });
  mkdirSync(join(leakDir, "secrets"), { recursive: true });

  writeFileSync(
    join(leakDir, "auth.json"),
    JSON.stringify({ deepseek: { type: "api_key", key: "$PI_PI_KEY_DEEPSEEK" } }, null, 2),
  );
  // 审计应看“脱敏后”的内容：这里的引用不会被抹
  const filesOk = [{ rel: "auth.json", size: 100, mtimeMs: 1, abs: join(leakDir, "auth.json") }];
  const auditOk = auditForPlaintext(filesOk, {
    agentDir: leakDir,
    config: { encrypt: false },
  });
  check("审计放过已迁移的 auth.json（引用形式）", auditOk.clean === true, JSON.stringify(auditOk.leaks));

  // 磁盘上留着明文备份副本：现在前缀匹配会一并脱敏，
  // 所以要断言的是“上传内容不含明文”，而不是“审计报错”。
  writeFileSync(
    join(leakDir, "auth.json.bak-2026-01-01"),
    JSON.stringify({ deepseek: { key: "sk-leaked-in-backup-copy-1234567890" } }),
  );
  const bakRel = "auth.json.bak-2026-01-01";
  const bakFiles = [{ rel: bakRel, size: 100, mtimeMs: 1, abs: join(leakDir, bakRel) }];
  const auditBak = auditForPlaintext(bakFiles, { agentDir: leakDir, config: { encrypt: false } });
  check("审计此时放行（因为会被脱敏）", auditBak.clean === true, JSON.stringify(auditBak.leaks));

  const { isRedactable } = await import("./backup.mjs");
  check("isRedactable 覆盖 .bak 副本", isRedactable(bakRel) === true);
  const redactedBak = redactSensitive(bakRel, Buffer.from(JSON.stringify({ deepseek: { key: "sk-leaked-in-backup-copy-1234567890" } })), {
    aggressive: true,
  });
  check(
    "auth.json.bak-* 的明文确实被脱敏（关键回归）",
    redactedBak !== null && !redactedBak.toString("utf8").includes("sk-leaked-in-backup-copy"),
    String(redactedBak).slice(0, 100),
  );

  // 真正无法脱敏的文件（不是 auth 类）仍应被审计拦下
  writeFileSync(join(leakDir, "extensions", "leakyconfig.json"), JSON.stringify({ token: "sk-plaintext-that-audit-must-catch-99" }));
  const auditLeaky = auditForPlaintext(
    [{ rel: "extensions/leakyconfig.json", size: 60, mtimeMs: 1, abs: join(leakDir, "extensions", "leakyconfig.json") }],
    { agentDir: leakDir, config: { encrypt: false } },
  );
  check("审计拦下非凭据文件里的明文", auditLeaky.clean === false, JSON.stringify(auditLeaky));

  // secrets/ 目录内的东西根本不该进入待上传列表
  writeFileSync(join(leakDir, "secrets", "password.txt"), "plain-password-here");
  check("looksCredentialFile 识别 secrets/", looksCredentialFile("secrets/password.txt") === true);
  check("looksCredentialFile 识别 secrets.dpapi.json", looksCredentialFile("secrets.dpapi.json") === true);
  check("looksCredentialFile 不误判普通扩展", looksCredentialFile("extensions/a.ts") === false);
  const auditSecrets = auditForPlaintext(
    [{ rel: "secrets/password.txt", size: 20, mtimeMs: 1, abs: join(leakDir, "secrets", "password.txt") }],
    { agentDir: leakDir, config: { encrypt: false } },
  );
  check("审计拦下 secrets/ 内文件", auditSecrets.clean === false, JSON.stringify(auditSecrets));

  // 默认排除规则必须拦住这些
  const { loadConfig } = await import("./config.mjs");
  writeFileSync(
    join(leakDir, "webdav-backup.json"),
    JSON.stringify({ remote: { url: "https://dav.example.com/dav/", username: "u", password: "pw-abcdefgh" } }),
  );
  process.env.PI_CODING_AGENT_DIR = leakDir;
  const lc = loadConfig();
  if (!lc.config) {
    check("审计用配置可加载", false, JSON.stringify(lc.errors));
  }
  const exc = lc.config?.exclude ?? [];
  check("默认排除含 secrets/**", exc.includes("secrets/**"));
  check("默认排除含 secrets.dpapi.json", exc.includes("secrets.dpapi.json"));
  check("默认排除含 *.bak-* 副本", exc.includes("**/*.bak-*"));

  const collected = collectFiles({ agentDir: leakDir, scope: ["."], exclude: exc });
  const rels2 = collected.files.map((f) => f.rel);
  check("收集时排除 auth.json.bak-*", !rels2.some((r) => r.includes(".bak-")), rels2.join(","));
  check("收集时排除 secrets/ 目录", !rels2.some((r) => r.startsWith("secrets/")), rels2.join(","));

  // 端到端：未加密备份遇到明文副本必须中止
  const davL = await startDavServer();
  davL.dirs.add("/dav");
  writeFileSync(
    join(leakDir, "webdav-backup.json"),
    JSON.stringify({
      remote: {
        url: `http://127.0.0.1:${davL.port}/dav`,
        username: "user",
        password: "pass",
        remoteDir: "bk",
        remoteName: "pi",
      },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = leakDir;
  const lc2 = loadConfig();
  if (!lc2.config) {
    check("端到端审计配置可加载", false, JSON.stringify(lc2.errors));
  }
  // 手工把一个含明文的文件混进配置扫描范围，验证审计会阻断
  writeFileSync(join(leakDir, "extensions", "leaky.json"), JSON.stringify({ apiKey: "sk-thisistotallyplaintextkey1234" }));
  const blocked = await runBackup({ ...lc2.config, snapshot: false }, {
    log: () => {},
    agentDir: leakDir,
    stateFile: join(leakDir, "s.json"),
    reason: "manual",
  });
  const blockedLeak = blocked.ok === false && Array.isArray(blocked.leaks);
  check("含明文凭据时备份被中止", blockedLeak, JSON.stringify(blocked).slice(0, 300));
  check("中止时未上传任何文件", davL.stats().putCount === 0, `putCount=${davL.stats().putCount}`);

  // 加密模式应放行（密文上传）
  process.env.PI_CODING_AGENT_DIR = leakDir;
  const encBlocked = await runBackup(
    { ...lc2.config, encrypt: true, encryptKey: "test-key-for-audit-16chars" },
    { log: () => {}, agentDir: leakDir, stateFile: join(leakDir, "s.json"), reason: "manual" },
  );
  check("加密模式下审计不阻断", encBlocked.ok === true, JSON.stringify(encBlocked).slice(0, 200));

  // 关键端到端：目录里存在 auth.json.bak-* 明文副本时，
  // 未加密备份应仍能完成（因为会被脱敏），且归档里绝不能出现明文。
  rmSync(join(leakDir, "extensions", "leaky.json"), { force: true });
  rmSync(join(leakDir, "extensions", "leakyconfig.json"), { force: true });
  davL.reset();
  const bakRun = await runBackup(
    { ...lc2.config, encrypt: false, remoteName: "pi-bak" },
    { log: () => {}, agentDir: leakDir, stateFile: join(leakDir, "s.json"), reason: "manual" },
  );
  check("含 .bak 副本时未加密备份仍可完成", bakRun.ok === true, JSON.stringify(bakRun).slice(0, 250));
  if (bakRun.ok) {
    const blobRaw = davL.store.get(`/dav/bk/${bakRun.archive}`);
    check("归档已上传", !!blobRaw);
    if (blobRaw) {
      const { gunzipSync } = await import("node:zlib");
      const text = gunzipSync(blobRaw).toString("latin1");
      // 排除规则是第一道防线：.bak 副本根本不进归档。
      // （即使有人删掉该规则，前面的脱敏回归测试保证明文也会被抹掉）
      check("归档不含 .bak 副本（被排除规则挡住）", !text.includes("auth.json.bak-"));
      check(
        "归档中无 .bak 副本明文（关键回归）",
        !text.includes("sk-leaked-in-backup-copy"),
        "明文密钥随备份副本泄露！",
      );
      check("正文 auth.json 仍在归档内", text.includes("auth.json"));
    }
  }

  davL.server.close();
  try {
    rmSync(leakDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(lines.join("\n"));
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
