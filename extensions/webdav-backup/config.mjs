/**
 * config.mjs — 配置读取与校验
 *
 * 配置文件：~/.pi/agent/webdav-backup.json
 * 兼容：环境变量 PI_WEBDAV_BACKUP_PASSWORD / PI_WEBDAV_BACKUP_PASS / PI_WEBDAV_BACKUP_KEY
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveSecret, isPlaintextSecret, dpapiAvailable } from "./secrets.mjs";
import {
  AGENT_DIR_ENV,
  resolveAgentDir,
  getAgentDir,
  configPath,
  statePath,
  logPath,
} from "./config-paths.mjs";

export { AGENT_DIR_ENV, resolveAgentDir, getAgentDir, configPath, statePath, logPath };

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

const DEFAULT_EXCLUDE = [
  "tmp/**",
  "web-search-cache/**",
  "npm/node_modules/**",
  "sessions/**",
  "**/*.log",
  "**/node_modules/**",
  // 密钥相关，绝不能进备份
  "secrets/**",
  "secrets.dpapi.json",
  // 迁移/编辑留下的备份副本可能含明文密钥
  "**/*.bak-*",
  "**/*.bak",
  "**/*.orig",
  "**/*.old",
  "**/*.save",
];

/**
 * 读取配置。返回 { ok, config, errors, warnings, raw }
 */
export function loadConfig() {
  const errors = [];
  const warnings = [];
  const p = configPath();

  if (!existsSync(p)) {
    return {
      ok: false,
      config: null,
      errors: [`配置文件不存在：${p}`],
      warnings,
      raw: null,
    };
  }

  let raw;
  try {
    raw = JSON.parse(stripBom(readFileSync(p, "utf8")));
  } catch (e) {
    return {
      ok: false,
      config: null,
      errors: [`配置文件不是合法 JSON：${e.message}`],
      warnings,
      raw: null,
    };
  }

  const remote = raw.remote ?? raw.webdav ?? {};

  // ── 解析密钥引用（不明文落盘）
  // password 回退链：配置值 → 专用环境变量
  const passwordRaw =
    remote.password ??
    process.env.PI_WEBDAV_BACKUP_PASSWORD ??
    process.env.PI_WEBDAV_BACKUP_PASS ??
    "";
  const passwordRes = resolveSecret(passwordRaw, { allowCommand: true, allowPlain: true });

  const keyRaw = raw.encryptKey ?? process.env.PI_WEBDAV_BACKUP_KEY ?? "";
  const keyRes = resolveSecret(keyRaw, { allowCommand: true, allowPlain: true });

  const config = {
    enabled: raw.enabled !== false,
    url: String(remote.url ?? "").trim(),
    username: String(remote.username ?? "").trim(),
    password: passwordRes.value ?? "",
    passwordSource: passwordRes.source,
    remoteDir: String(remote.remoteDir ?? raw.remoteDir ?? "pi-backup").replace(/^\/+|\/+$/g, ""),
    remoteName: String(remote.remoteName ?? raw.remoteName ?? "pi-agent").trim(),
    scope: Array.isArray(raw.scope) && raw.scope.length > 0 ? raw.scope.map(String) : ["."],
    exclude: Array.isArray(raw.exclude)
      ? [...DEFAULT_EXCLUDE, ...raw.exclude.map(String)]
      : DEFAULT_EXCLUDE,
    includeSessions: raw.includeSessions === true,
    snapshot: raw.snapshot === true,
    encrypt: raw.encrypt === true,
    encryptKey: keyRes.value ?? null,
    encryptKeySource: keyRes.source,
    backupOnExit: raw.backupOnExit !== false,
    backupOnExitMinIntervalMinutes: Number(raw.backupOnExitMinIntervalMinutes ?? 30),
    backupOnExitTimeoutMs: Number(raw.backupOnExitTimeoutMs ?? 10 * 60 * 1000),
    timeoutMs: Number(raw.timeoutMs ?? 60_000),
    insecureTls: raw.insecureTls === true,
    keepVersions: Number(raw.keepVersions ?? 10),
  };

  if (!config.url) errors.push("缺少 remote.url（WebDAV 地址）");
  else if (!/^https?:\/\//i.test(config.url)) errors.push("remote.url 必须以 http:// 或 https:// 开头");

  // 密钥解析错误直接阻断（否则会拿空密码去连）
  if (passwordRes.error) errors.push(`remote.password 解析失败：${passwordRes.error}`);
  if (keyRes.error) errors.push(`encryptKey 解析失败：${keyRes.error}`);

  // 明文告警
  if (isPlaintextSecret(passwordRaw)) {
    warnings.push(
      "remote.password 是明文，建议改为 dpapi:webdav-password" +
        (dpapiAvailable() ? "（/backup-setup 可自动转换）" : " 或 $PI_WEBDAV_BACKUP_PASSWORD"),
    );
  }
  if (passwordRaw && isPlaintextSecret(passwordRaw) === false && passwordRes.source === "env") {
    // 来自环境变量，无需告警
  }

  if (config.username && !config.password) {
    const hint = passwordRaw
      ? `（已配置 remote.password 引用但解析为空，来源：${passwordRes.source}）`
      : "（可设置 remote.password 为 dpapi:名称，或环境变量 PI_WEBDAV_BACKUP_PASSWORD）";
    warnings.push(`配置了 username 但没有可用 password ${hint}`);
  }
  if (!config.username && !config.password) {
    warnings.push("未配置用户名/密码，将以匿名方式连接（部分服务端会拒绝）");
  }

  if (config.encrypt && !config.encryptKey) {
    errors.push("encrypt 为 true，但缺少可用 encryptKey（可设为 dpapi:名称 或 $PI_WEBDAV_BACKUP_KEY）");
  }
  if (config.encryptKey && String(config.encryptKey).length < 16) {
    errors.push("encryptKey 至少需要 16 个字符");
  }
  if (config.encryptKey && isPlaintextSecret(keyRaw)) {
    warnings.push("encryptKey 是明文，建议改为 dpapi:backup-key");
  }

  return { ok: errors.length === 0, config, errors, warnings, raw, secrets: { passwordSource: passwordRes.source, encryptKeySource: keyRes.source, passwordWarning: passwordRes.warning, encryptKeyWarning: keyRes.warning } };
}

/** 生成一份带注释的配置模板（写盘时用，JSON 不支持注释故存为 _ 前缀键） */
export function configTemplate() {
  return {
    _说明: "pi WebDAV 备份配置。修改后运行 /reload 或 /backup-setup 生效。",
    enabled: true,
    remote: {
      _说明_url: "WebDAV 服务地址，例如坚果云 https://dav.jianguoyun.com/dav/",
      url: "",
      _说明_username: "登录邮箱 / 用户名",
      username: "",
      _说明_password:
        "密钥引用，推荐 dpapi:webdav-password（Windows 用户级加密，无需主密码）；也可 $ENV_VAR 或 file:路径。留空则读环境变量 PI_WEBDAV_BACKUP_PASSWORD",
      password: "",
      _说明_remoteDir: "远端保存目录",
      remoteDir: "pi-backup",
      _说明_remoteName: "本次备份的目录名（生成 pi-agent-<时间戳>.tar.gz）",
      remoteName: "pi-agent",
    },
    _说明_scope: "要备份的路径，相对 ~/.pi/agent",
    scope: ["."],
    _说明_exclude: "额外排除规则（glob），内置已排除 tmp/、sessions/、缓存、node_modules",
    exclude: [],
    _说明_includeSessions: "是否包含会话历史（可能很大）",
    includeSessions: false,
    _说明_snapshot: "true=逐文件快照上传（增量，可单文件恢复）；false=打包成单个 tar.gz（默认）",
    snapshot: false,
    _说明_encrypt: "是否加密（AES-256-GCM），强烈建议开启",
    encrypt: false,
    _说明_encryptKey: "密钥引用，推荐 dpapi:backup-key；至少 16 位",
    encryptKey: "",
    _说明_backupOnExit: "退出 pi 时自动备份",
    backupOnExit: true,
    _说明_backupOnExitMinIntervalMinutes: "两次自动备份的最小间隔（分钟），防止频繁开关 pi 造成重复上传",
    backupOnExitMinIntervalMinutes: 30,
    _说明_backupOnExitTimeoutMs: "自动备份最长等待时间（毫秒）",
    backupOnExitTimeoutMs: 600000,
    _说明_keepVersions: "保留最近 N 个备份，更早的自动删除（0 = 不清理）",
    keepVersions: 10,
    _说明_timeoutMs: "单次 HTTP 请求超时（毫秒）",
    timeoutMs: 60000,
    insecureTls: false,
  };
}
