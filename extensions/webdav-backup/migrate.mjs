/**
 * migrate.mjs — 把配置里的明文密钥迁移为安全引用
 *
 * 迁移策略：
 *   plain  →  dpapi:<名称>      （Windows，推荐：本机本用户可解，无主密码）
 *   plain  →  $ENV_VAR          （跨平台，写入用户级环境变量）
 *   plain  →  file:<路径>        （写入 0600 权限的独立文件）
 *
 * 迁移后原配置文件只保留引用字符串，明文不再落盘。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

import { configPath, getAgentDir } from "./config-paths.mjs";
import {
  setDpapiSecret,
  dpapiAvailable,
  setUserEnvVar,
  DPAPI_SCHEME,
  FILE_SCHEME,
} from "./secrets.mjs";

const ENV_PASSWORD = "PI_WEBDAV_BACKUP_PASSWORD";
const ENV_KEY = "PI_WEBDAV_BACKUP_KEY";
const DPAPI_PASSWORD_NAME = "webdav-password";
const DPAPI_KEY_NAME = "backup-key";

function stripBom(t) {
  return t.replace(/^\uFEFF/, "");
}

/** 判断配置里的值是否为明文（需要迁移） */
function needsMigration(v) {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!t) return false;
  if (
    t.startsWith(DPAPI_SCHEME) ||
    t.startsWith(FILE_SCHEME) ||
    t.startsWith("plain:") ||
    t.startsWith("!")
  ) {
    return false;
  }
  if (t.includes("$")) return false;
  return true;
}

function backupFile(p) {
  if (!existsSync(p)) return null;
  const dest = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(p, dest);
  return dest;
}

/**
 * 执行迁移。
 * @param {object} opts
 * @param {"dpapi"|"env"|"file"} opts.method
 * @param {(s: string) => void} opts.log
 * @param {boolean} [opts.dryRun]
 */
export async function migrateSecrets({ method = "dpapi", log = () => {}, dryRun = false } = {}) {
  const p = configPath();
  if (!existsSync(p)) {
    return { ok: false, error: `配置文件不存在：${p}` };
  }

  let raw;
  try {
    raw = JSON.parse(stripBom(readFileSync(p, "utf8")));
  } catch (e) {
    return { ok: false, error: `配置文件不是合法 JSON：${e.message}` };
  }

  const remote = raw.remote ?? {};
  const changes = [];

  const plan = [];
  if (needsMigration(remote.password)) {
    plan.push({ field: "remote.password", value: remote.password.trim(), kind: "password" });
  }
  if (needsMigration(raw.encryptKey)) {
    plan.push({ field: "encryptKey", value: raw.encryptKey.trim(), kind: "key" });
  }

  if (plan.length === 0) {
    return { ok: true, migrated: 0, message: "配置中没有明文密钥，无需迁移" };
  }

  if (method === "dpapi" && !dpapiAvailable()) {
    return { ok: false, error: "DPAPI 仅支持 Windows；请改用 --method env 或 --method file" };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldMigrate: plan.map((x) => ({ field: x.field, method, target: method === "env" ? (x.kind === "password" ? ENV_PASSWORD : ENV_KEY) : method === "dpapi" ? `${DPAPI_SCHEME}${x.kind === "password" ? DPAPI_PASSWORD_NAME : DPAPI_KEY_NAME}` : `${FILE_SCHEME}secrets/${x.kind}.txt` })),
    };
  }

  // 先备份原文件，再逐项迁移
  const backup = backupFile(p);
  if (backup) log(`已备份原配置：${backup}`);

  const secretsDir = join(getAgentDir(), "secrets");

  for (const item of plan) {
    if (method === "dpapi") {
      const name = item.kind === "password" ? DPAPI_PASSWORD_NAME : DPAPI_KEY_NAME;
      setDpapiSecret(name, item.value);
      const ref = `${DPAPI_SCHEME}${name}`;
      if (item.kind === "password") remote.password = ref;
      else raw.encryptKey = ref;
      changes.push({ field: item.field, to: ref });
      log(`已用 DPAPI 加密保存并替换 ${item.field} → ${ref}`);
      continue;
    }

    if (method === "env") {
      const envName = item.kind === "password" ? ENV_PASSWORD : ENV_KEY;
      const r = setUserEnvVar(envName, item.value);
      const ref = `$${envName}`;
      if (item.kind === "password") remote.password = ref;
      else raw.encryptKey = ref;
      changes.push({ field: item.field, to: ref, note: r.note });
      log(r.ok ? `已写入用户环境变量 ${envName}，并替换 ${item.field} → ${ref}` : `请手动设置 ${envName}；配置已改为 ${ref}`);
      continue;
    }

    if (method === "file") {
      mkdirSync(secretsDir, { recursive: true });
      const file = join(secretsDir, `${item.kind}.txt`);
      writeFileSync(file, item.value, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* ignore */
      }
      const ref = `${FILE_SCHEME}${file}`;
      if (item.kind === "password") remote.password = ref;
      else raw.encryptKey = ref;
      changes.push({ field: item.field, to: ref });
      log(`已写入 ${file}（0600）并替换 ${item.field} → ${ref}`);
      continue;
    }

    return { ok: false, error: `未知迁移方式：${method}` };
  }

  raw.remote = remote;
  writeFileSync(p, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* ignore */
  }

  // 迁移到 file 方式时提醒保护目录
  if (method === "file") {
    log(`注意：${secretsDir} 内为明文密钥文件，请确保该目录不被同步/备份到不可信位置。`);
  }

  return { ok: true, migrated: changes.length, method, changes, backup };
}
