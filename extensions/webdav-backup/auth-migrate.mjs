/**
 * auth-migrate.mjs — 把 auth.json 里的明文 API 密钥改为安全引用
 *
 * pi 的 auth.json 结构：
 *   { "<provider>": { "type": "api_key", "key": "<明文 或 $ENV_VAR 或 !命令>" } }
 *
 * auth-storage.js 的 read() 会对 key 调用 resolveConfigValue，
 * 因此 $ENV_VAR / !命令 / ${VAR} 引用是被官方支持的。
 *
 * 迁移策略（每项单独选择）：
 *   env   → $PI_PI_KEY_<PROVIDER>      （默认，与其它 pi 用法一致，跨平台）
 *   dpapi → dpapi:auth-<provider>      （Windows，无主密码）
 *   keep  → 不动
 *
 * 重要：key 为空字符串时 pi 用它表达“未配置”，必须保留为空，不能改成引用，
 * 否则会把“未登录”变成“引用一个不存在的变量”。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "./config-paths.mjs";
import {
  setDpapiSecret,
  dpapiAvailable,
  setUserEnvVar,
  readUserEnvVar,
  envVarVisible,
} from "./secrets.mjs";

export function authJsonPath() {
  return join(getAgentDir(), "auth.json");
}

/** 判断 key 是否已是引用形式 */
function isReference(key) {
  if (typeof key !== "string") return false;
  const t = key.trim();
  if (!t) return false;
  if (t.startsWith("$") || t.startsWith("!") || t.startsWith("dpapi:") || t.startsWith("file:")) return true;
  return false;
}

/** 由 provider id 生成合法环境变量名 */
export function envVarNameFor(providerId) {
  const normalized = String(providerId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `PI_PI_KEY_${normalized}`;
}

function readAuth() {
  const p = authJsonPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return { __parseError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 扫描 auth.json，列出需要迁移的明文密钥。
 */
export function scanAuthSecrets() {
  const data = readAuth();
  if (data === null) {
    return { ok: false, error: `auth.json 不存在：${authJsonPath()}`, items: [] };
  }
  if (data.__parseError) {
    return { ok: false, error: `auth.json 不是合法 JSON：${data.__parseError}`, items: [] };
  }

  const items = [];
  for (const [providerId, cred] of Object.entries(data)) {
    if (!cred || typeof cred !== "object") continue;
    const key = cred.key;
    if (typeof key !== "string") continue;

    if (key.trim() === "") {
      items.push({ provider: providerId, kind: "empty", keyLength: 0, action: "skip", reason: "空值表示未配置，保持原样" });
      continue;
    }
    if (isReference(key)) {
      items.push({ provider: providerId, kind: "reference", action: "skip", reason: "已是安全引用", current: key });
      continue;
    }
    items.push({
      provider: providerId,
      kind: "plaintext",
      keyLength: key.length,
      action: "migrate",
      suggestedEnv: envVarNameFor(providerId),
      suggestedDpapi: `dpapi:auth-${providerId}`,
    });
  }
  return { ok: true, items, path: authJsonPath() };
}

/**
 * 执行迁移。
 *
 * @param {object} opts
 * @param {"env"|"dpapi"} opts.method
 * @param {Record<string, "env"|"dpapi"|"keep">} [opts.perProvider]
 * @param {(s: string) => void} [opts.log]
 * @param {boolean} [opts.dryRun]
 */
export async function migrateAuthJson({ method = "env", perProvider = {}, log = () => {}, dryRun = false } = {}) {
  const scan = scanAuthSecrets();
  if (!scan.ok) return { ok: false, error: scan.error };

  const targets = scan.items.filter((it) => it.kind === "plaintext");
  if (targets.length === 0) {
    return { ok: true, migrated: 0, message: "auth.json 中没有明文密钥，无需迁移", skipped: scan.items };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldMigrate: targets.map((t) => {
        const m = perProvider[t.provider] ?? method;
        return {
          provider: t.provider,
          method: m,
          target: m === "dpapi" ? t.suggestedDpapi : `$${t.suggestedEnv}`,
        };
      }),
    };
  }

  const data = readAuth();
  const p = authJsonPath();
  const backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(p, backup);
  log(`已备份 auth.json → ${backup}`);

  const changes = [];
  const warnings = [];

  for (const item of targets) {
    const chosen = perProvider[item.provider] ?? method;
    if (chosen === "keep") {
      log(`跳过 ${item.provider}（用户选择保留）`);
      continue;
    }

    const plaintext = data[item.provider].key;

    if (chosen === "dpapi") {
      if (!dpapiAvailable()) {
        warnings.push(`${item.provider}：DPAPI 不可用，已跳过`);
        continue;
      }
      const name = `auth-${item.provider}`;
      try {
        setDpapiSecret(name, plaintext);
      } catch (e) {
        warnings.push(`${item.provider}：DPAPI 保存失败 — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      data[item.provider].key = `dpapi:${name}`;
      changes.push({ provider: item.provider, to: `dpapi:${name}`, method: "dpapi" });
      log(`${item.provider} → dpapi:${name}`);
      continue;
    }

    // env（默认）
    const envName = envVarNameFor(item.provider);
    try {
      const r = setUserEnvVar(envName, plaintext);
      if (!r.ok) {
        warnings.push(`${item.provider}：${r.note}`);
        continue;
      }
    } catch (e) {
      warnings.push(`${item.provider}：写入环境变量失败 — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // 写入注册表后当前进程看不到；从注册表读回确认
    const readBack = readUserEnvVar(envName);
    if (readBack === undefined) {
      warnings.push(`${item.provider}：环境变量 ${envName} 写入后读回失败，已跳过以免丢失密钥`);
      continue;
    }
    if (readBack !== plaintext) {
      warnings.push(`${item.provider}：环境变量 ${envName} 读回值不一致，已跳过以免丢失密钥`);
      continue;
    }

    // 让当前进程立刻可用（这样本次运行不需要重启也能用）
    process.env[envName] = plaintext;

    data[item.provider].key = `$${envName}`;
    changes.push({ provider: item.provider, to: `$${envName}`, method: "env", envName });
    log(`${item.provider} → $${envName}`);
  }

  if (changes.length === 0) {
    return { ok: false, error: "没有任何条目迁移成功", warnings, backup };
  }

  writeFileSync(p, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* ignore */
  }

  // 校验：迁移后文件里不应再出现明文
  const after = readFileSync(p, "utf8");
  const stillPlain = scanAuthSecrets().items.filter((i) => i.kind === "plaintext");

  return {
    ok: stillPlain.length === 0,
    migrated: changes.length,
    changes,
    warnings,
    backup,
    remainingPlaintext: stillPlain.map((s) => s.provider),
    envVarsNeedRestart: changes.filter((c) => c.method === "env").map((c) => c.envName),
    fileNote: after.length > 0 ? undefined : undefined,
  };
}

/** 还原：从备份恢复 auth.json */
export function restoreAuthJson(backupPath) {
  const p = authJsonPath();
  if (!existsSync(backupPath)) return { ok: false, error: `备份不存在：${backupPath}` };
  copyFileSync(backupPath, p);
  return { ok: true, restoredFrom: backupPath };
}
