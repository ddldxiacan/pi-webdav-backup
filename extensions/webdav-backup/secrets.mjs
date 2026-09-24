/**
 * secrets.mjs — 密钥引用解析与安全存储
 *
 * 设计目标：配置文件里不出现明文密钥。
 *
 * 支持的值语法（与 pi 自身的 resolve-config-value 约定保持一致，便于理解）：
 *   "$ENV_VAR" / "${ENV_VAR}"   环境变量
 *   "!command"                  执行命令取 stdout（如密码管理器 CLI）
 *   "dpapi:名称"                Windows DPAPI 用户级加密（本机本用户可解，无需主密码）
 *   "file:路径"                 从文件读取（自动 strip 换行）
 *   "plain:值"                  显式声明明文（会告警，仅用于临时调试）
 *   其他任意值                   视为明文（会告警）
 *
 * DPAPI 存储位置：~/.pi/agent/secrets.dpapi.json
 * 该文件即使被复制走，在别的机器/用户下也无法解密。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "./config-paths.mjs";

export const DPAPI_SCHEME = "dpapi:";
export const FILE_SCHEME = "file:";
export const PLAIN_SCHEME = "plain:";

/** DPAPI 密文仓库路径 */
export function dpapiStorePath() {
  return join(getAgentDir(), "secrets.dpapi.json");
}

const isWindows = process.platform === "win32";

// ─────────────────────────────────────────────── DPAPI 原语

/**
 * 用 PowerShell 调用 Windows DPAPI（ProtectedData, CurrentUser 作用域）。
 * 密文以 base64 存储。
 */
function dpapiEncrypt(text) {
  if (!isWindows) throw new Error("DPAPI 仅支持 Windows");
  const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: text,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.error) throw new Error(`DPAPI 加密失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`DPAPI 加密失败：${(r.stderr ?? "").trim() || `退出码 ${r.status}`}`);
  const b64 = (r.stdout ?? "").trim();
  if (!b64) throw new Error("DPAPI 加密失败：输出为空");
  return b64;
}

function dpapiDecrypt(b64) {
  if (!isWindows) throw new Error("DPAPI 仅支持 Windows");
  const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$enc = [Convert]::FromBase64String($b64)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: b64,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.error) throw new Error(`DPAPI 解密失败：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`DPAPI 解密失败（可能不是本机本用户加密的）：${(r.stderr ?? "").trim()}`);
  }
  return r.stdout ?? "";
}

export function dpapiAvailable() {
  return isWindows;
}

// ─────────────────────────────────────────────── DPAPI 仓库读写

function readDpapiStore() {
  const p = dpapiStorePath();
  try {
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeDpapiStore(store) {
  const p = dpapiStorePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 上可能无效，忽略 */
  }
}

/** 写入一个 DPAPI 加密的密钥 */
export function setDpapiSecret(name, value) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`密钥名称只能包含字母、数字、点、下划线、连字符：${name}`);
  }
  const store = readDpapiStore();
  store[name] = {
    v: 1,
    scope: "CurrentUser",
    updatedAt: new Date().toISOString(),
    value: dpapiEncrypt(String(value)),
  };
  writeDpapiStore(store);
  return true;
}

export function getDpapiSecret(name) {
  const entry = readDpapiStore()[name];
  if (!entry) return undefined;
  const payload = typeof entry === "string" ? entry : entry?.value;
  if (!payload) return undefined;
  return dpapiDecrypt(payload);
}

export function deleteDpapiSecret(name) {
  const store = readDpapiStore();
  if (!(name in store)) return false;
  delete store[name];
  writeDpapiStore(store);
  return true;
}

/** 列出已存的密钥名与元信息（不含明文） */
export function listDpapiSecrets() {
  const store = readDpapiStore();
  return Object.entries(store).map(([name, entry]) => ({
    name,
    updatedAt: typeof entry === "object" ? entry.updatedAt : undefined,
    scope: typeof entry === "object" ? entry.scope : "CurrentUser",
  }));
}

// ─────────────────────────────────────────────── 值解析

/**
 * 解析一个配置值引用。
 *
 * @param {unknown} value 原始配置值
 * @param {{env?: Record<string, string>, allowCommand?: boolean, allowPlain?: boolean}} [opts]
 * @returns {{value: string|undefined, source: string, warning?: string, error?: string}}
 */
export function resolveSecret(value, opts = {}) {
  const { env = process.env, allowCommand = true, allowPlain = true } = opts;

  if (value === undefined || value === null || value === "") {
    return { value: undefined, source: "empty" };
  }
  if (typeof value !== "string") {
    return { value: String(value), source: "non-string" };
  }

  const raw = value;

  // dpapi:名称
  if (raw.startsWith(DPAPI_SCHEME)) {
    const name = raw.slice(DPAPI_SCHEME.length).trim();
    if (!name) return { value: undefined, source: "dpapi", error: "dpapi: 后缺少密钥名称" };
    if (!dpapiAvailable()) {
      return { value: undefined, source: "dpapi", error: "DPAPI 仅支持 Windows；请改用 $ENV 或 file:" };
    }
    try {
      const v = getDpapiSecret(name);
      if (v === undefined) {
        return { value: undefined, source: "dpapi", error: `DPAPI 仓库中找不到密钥「${name}」` };
      }
      return { value: v, source: "dpapi" };
    } catch (e) {
      return { value: undefined, source: "dpapi", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // file:路径
  if (raw.startsWith(FILE_SCHEME)) {
    const p0 = raw.slice(FILE_SCHEME.length).trim();
    if (!p0) return { value: undefined, source: "file", error: "file: 后缺少路径" };
    const p = isAbsolute(p0) ? p0 : resolve(getAgentDir(), p0);
    try {
      if (!existsSync(p)) return { value: undefined, source: "file", error: `密钥文件不存在：${p}` };
      const text = readFileSync(p, "utf8").replace(/^\uFEFF/, "").trim();
      if (!text) return { value: undefined, source: "file", error: `密钥文件为空：${p}` };
      return { value: text, source: "file" };
    } catch (e) {
      return { value: undefined, source: "file", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // plain:值 —— 显式明文，告警
  if (raw.startsWith(PLAIN_SCHEME)) {
    const v = raw.slice(PLAIN_SCHEME.length);
    if (!allowPlain) return { value: undefined, source: "plain", error: "不允许明文密钥" };
    return {
      value: v,
      source: "plain",
      warning: "该值以 plain: 明文存储，建议改用 dpapi: / $ENV / file:",
    };
  }

  // !command —— 执行命令取 stdout
  if (raw.startsWith("!")) {
    if (!allowCommand) return { value: undefined, source: "command", error: "不允许执行命令取值" };
    const cmd = raw.slice(1);
    if (!cmd.trim()) return { value: undefined, source: "command", error: "! 后缺少命令" };
    try {
      const out = execSync(cmd, {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const v = String(out ?? "").replace(/\r?\n$/, "").trim();
      if (!v) return { value: undefined, source: "command", error: `命令无输出：${cmd}` };
      return { value: v, source: "command" };
    } catch (e) {
      return {
        value: undefined,
        source: "command",
        error: `命令执行失败：${cmd}（${e instanceof Error ? e.message.split("\n")[0] : String(e)}）`,
      };
    }
  }

  // $ENV / ${ENV} 以及模板插值（与 pi 的 resolve-config-value 语义一致）
  if (raw.includes("$")) {
    const parts = parseTemplate(raw);
    if (parts.missing.length > 0) {
      return {
        value: undefined,
        source: "env",
        error: `环境变量未设置：${parts.missing.join(", ")}`,
      };
    }
    const v = parts.parts
      .map((p) => (p.type === "literal" ? p.value : (env[p.name] ?? "")))
      .join("");
    if (!v) return { value: undefined, source: "env", error: "解析结果为空" };
    return { value: v, source: "env" };
  }

  // 其他：字面量，即明文
  if (!allowPlain) return { value: undefined, source: "literal", error: "配置中不允许出现明文" };
  return {
    value: raw,
    source: "literal",
    warning: "检测到明文密钥，建议改用 dpapi:名称（推荐）或 $ENV_VAR",
  };
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseTemplate(config) {
  const parts = [];
  const missing = [];
  let i = 0;
  while (i < config.length) {
    const d = config.indexOf("$", i);
    if (d < 0) {
      if (i < config.length) parts.push({ type: "literal", value: config.slice(i) });
      break;
    }
    if (d > i) parts.push({ type: "literal", value: config.slice(i, d) });
    const next = config[d + 1];
    if (next === "$" || next === "!") {
      parts.push({ type: "literal", value: next });
      i = d + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", d + 2);
      if (end < 0) {
        parts.push({ type: "literal", value: "$" });
        i = d + 1;
        continue;
      }
      const name = config.slice(d + 2, end);
      if (ENV_NAME_RE.test(name)) {
        parts.push({ type: "env", name });
        if (process.env[name] === undefined) missing.push(name);
      } else {
        parts.push({ type: "literal", value: config.slice(d, end + 1) });
      }
      i = end + 1;
      continue;
    }
    const m = config.slice(d + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      parts.push({ type: "env", name: m[0] });
      if (process.env[m[0]] === undefined) missing.push(m[0]);
      i = d + 1 + m[0].length;
      continue;
    }
    parts.push({ type: "literal", value: "$" });
    i = d + 1;
  }
  return { parts, missing };
}

/** 判断某个值是否为「明文」（需要提示用户） */
export function isPlaintextSecret(value) {  if (value === undefined || value === null || value === "") return false;
  if (typeof value !== "string") return true;
  const v = value.trim();
  if (!v) return false;
  if (v.startsWith(DPAPI_SCHEME) || v.startsWith(FILE_SCHEME) || v.startsWith(PLAIN_SCHEME)) return false;
  if (v.startsWith("!")) return false;
  if (v.includes("$")) return false;
  return true;
}

// ─────────────────────────────────────────────── 环境变量持久化

/**
 * 设置用户级环境变量。
 *
 * 安全细节：通过 stdin 把值传给 PowerShell，而不是作为命令行参数，
 * 避免密钥出现在进程列表（tasklist / ps）中。
 *
 * 注意：用户级环境变量写入注册表，当前进程不会立即看到，需新进程生效。
 */
export function setUserEnvVar(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`环境变量名不合法：${name}`);
  }
  const str = String(value);

  if (isWindows) {
    const script = `
$ErrorActionPreference = "Stop"
$v = [Console]::In.ReadToEnd()
[Environment]::SetEnvironmentVariable(${JSON.stringify(name)}, $v, 'User')
`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: str,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    if (r.error) throw new Error(`设置环境变量失败：${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(`设置环境变量失败：${(r.stderr ?? "").trim() || `退出码 ${r.status}`}`);
    }
    return { ok: true, method: "registry", note: "需新开进程/重启 pi 后生效" };
  }

  return {
    ok: false,
    method: "manual",
    note: `请手动把 export ${name}=... 写入 ~/.bashrc 或 ~/.zshrc`,
  };
}

/** 从注册表读回用户级环境变量（用于验证写入结果，当前进程看不到新值） */
export function readUserEnvVar(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  if (!isWindows) return undefined;
  const script = `
$ErrorActionPreference = "Stop"
[Environment]::GetEnvironmentVariable(${JSON.stringify(name)}, 'User')
`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (r.status !== 0) return undefined;
  const v = (r.stdout ?? "").replace(/\r?\n$/, "");
  return v || undefined;
}

/** 检查某环境变量是否已在当前进程中可见 */
export function envVarVisible(name) {
  return process.env[name] !== undefined && process.env[name] !== "";
}
