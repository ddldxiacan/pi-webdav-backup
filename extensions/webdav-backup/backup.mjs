/**
 * backup.mjs — 备份引擎
 *
 * 两种模式：
 *  1. 归档模式（默认，稳妥）：打包成一个 tar.gz（可加密）整体上传。
 *     - 引擎内含极简 tar 写入器，零依赖
 *     - 远端文件名：<remoteName>-<时间戳>.tar.gz（或 .tar.gz.pibak）
 *  2. 快照模式（snapshot: true）：逐个文件上传到远端 <remoteName>/ 目录，
 *     用 manifest.json 做增量比对，只传变化的文件。
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";

import { WebDAVClient } from "./webdav.mjs";
import { collectFiles } from "./collect.mjs";
import { encryptFile, sha256Buffer, sha256File } from "./crypto.mjs";

const TAR_BLOCK = 512;

/** 极简 tar (ustar) 写入器 */
class TarWriter {
  constructor(out) {
    this.out = out;
    this.pending = 0;
  }

  #header(name, size, mtimeMs, mode = 0o644, type = "0") {
    const buf = Buffer.alloc(TAR_BLOCK);
    const safeName = Buffer.from(name, "utf8");
    if (safeName.length > 100) {
      // 长名：用 ustar prefix 拆分
      const idx = name.lastIndexOf("/", 155);
      const prefix = Buffer.from(name.slice(0, idx), "utf8");
      const rest = Buffer.from(name.slice(idx + 1), "utf8");
      names: {
        if (prefix.length > 155 || rest.length > 100) break names;
        prefix.copy(buf, 345, 0, Math.min(prefix.length, 155));
        rest.copy(buf, 0, 0, Math.min(rest.length, 100));
      }
      if (buf[0] === 0) {
        safeName.copy(buf, 0, 0, Math.min(safeName.length, 100));
      }
    } else {
      safeName.copy(buf, 0, 0, safeName.length);
    }

    this.#octal(buf, 100, 8, mode & 0o7777);
    this.#octal(buf, 108, 8, 0);
    this.#octal(buf, 116, 8, 0);
    this.#octal(buf, 124, 12, size);
    this.#octal(buf, 136, 12, Math.floor((mtimeMs ?? Date.now()) / 1000));
    buf.write("        ", 148, 8, "ascii"); // checksum 占位（8 空格）
    buf.write(type, 156, 1, "ascii");
    buf.write("ustar\0", 257, 6, "ascii");
    buf.write("00", 263, 2, "ascii");

    let sum = 0;
    for (const b of buf) sum += b;
    const cs = sum.toString(8).padStart(6, "0") + "\0 ";
    buf.write(cs, 148, 8, "ascii");
    return buf;
  }

  #octal(buf, offset, len, value) {
    const s = Math.max(0, Math.floor(value)).toString(8).padStart(len - 1, "0");
    buf.write(s.slice(-(len - 1)), offset, len - 1, "ascii");
    buf[offset + len - 1] = 0;
  }

  async #write(chunk) {
    if (!this.out.write(chunk)) {
      await new Promise((resolve) => this.out.once("drain", resolve));
    }
  }

  async addFile(absPath, relPath, { size, mtimeMs }) {
    const header = this.#header(relPath.replace(/\\/g, "/"), size, mtimeMs);
    await this.#write(header);

    await new Promise((resolve, reject) => {
      const rs = createReadStream(absPath);
      let written = 0;
      rs.on("data", async (c) => {
        written += c.length;
        if (!this.out.write(c)) {
          rs.pause();
          this.out.once("drain", () => rs.resume());
        }
      });
      rs.on("end", () => {
        const pad = (TAR_BLOCK - (written % TAR_BLOCK)) % TAR_BLOCK;
        if (pad > 0) this.out.write(Buffer.alloc(pad));
        resolve();
      });
      rs.on("error", reject);
    });

    return { written: size };
  }

  async addBuffer(content, relPath, mtimeMs = Date.now(), mode = 0o600) {
    const buf = Buffer.from(content);
    await this.#write(this.#header(relPath.replace(/\\/g, "/"), buf.length, mtimeMs, mode));
    await this.#write(buf);
    const pad = (TAR_BLOCK - (buf.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad > 0) await this.#write(Buffer.alloc(pad));
  }

  /** 结束：两个全零块 */
  async finish() {
    await this.#write(Buffer.alloc(TAR_BLOCK * 2));
    await new Promise((resolve, reject) => {
      this.out.end((err) => (err ? reject(err) : resolve()));
    });
  }
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 归档名的严格匹配式：<remoteName>-YYYYMMDD-HHMMSS.tar.gz[.pibak]
 * 必须精确到时间戳格式，否则 remoteName="pi" 会意外匹配到 "pi-enc-..."、
 * 造成恢复选错文件或 prune 误删其他前缀的备份。
 */
export function archiveNameRe(remoteName) {
  return new RegExp(`^${escapeRe(remoteName)}-\\d{8}-\\d{6}\\.tar\\.gz(\\.pibak)?$`);
}

/** manifest 文件名：manifest-YYYYMMDD-HHMMSS.json */
export function manifestNameRe() {
  return /^manifest-\d{8}-\d{6}\.json$/;
}

/** 读取上次备份状态 */
export function readState(stateFile) {
  try {
    if (!existsSync(stateFile)) return null;
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(stateFile, state) {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* 状态写入失败不影响备份 */
  }
}

/**
 * 判断一个相对路径的文件是否属于“需要脱敏”的凭据文件。
 *
 * 单一事实来源：脱敏函数、写入路径、审计三方必须用同一个判断，
 * 否则会出现“审计说安全、实际却传了明文”的不一致。
 *
 * 按前缀匹配是有意的：
 *   auth.json.bak-2026-... / auth.json.tmp 这类副本同样是明文密钥。
 */
export function isRedactable(relPath) {
  const base = String(relPath).split("/").pop() ?? "";
  return base.startsWith("auth.json") || base.startsWith("webdav-backup.json");
}

/**
 * 脱敏敏感文件内容。
 *
 * @param {string} relPath
 * @param {Buffer} buf
 * @param {{aggressive?: boolean}} [opts]
 *   aggressive=true（未加密备份时使用）：按字段名 + 值形状双重判断，
 *   尽量不遗漏任何凭据；aggressive=false 时仍会脱敏已知字段。
 * @returns {Buffer|null} null 表示无需脱敏
 */
export function redactSensitive(relPath, buf, opts = {}) {
  const aggressive = opts.aggressive !== false;
  const base = relPath.split("/").pop() ?? "";

  const SECRET_KEY_RE = /key|token|secret|password|passwd|credential|api[-_]?key|auth(?!or)|cookie|session[-_]?(token|key|secret|id)|bearer|private/i;
  // 密钥引用（$ENV / !cmd / dpapi: / file:）是“密钥放在哪”的指针，不是秘密本身，应保留
  const SECRET_REF_SCHEMES = ["$", "!", "dpapi:", "file:"];
  const isRef = (v) =>
    typeof v === "string" && SECRET_REF_SCHEMES.some((p) => v.trim().startsWith(p));
  // 常见凭据前缀，以及“长且像随机串”的值
  const SECRET_VALUE_RE =
    /^(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9_+/=-]{32,})$/;

  const looksSecret = (v) => typeof v === "string" && SECRET_VALUE_RE.test(v.trim());

  const redactJson = (obj, { aggressiveValues }) => {
    const walk = (v, keyHint = "") => {
      if (Array.isArray(v)) return v.map((x) => walk(x, keyHint));
      if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          if (SECRET_KEY_RE.test(k)) {
            // 保留结构，抹掉值。
            // 只替换字符串：布尔/数字不可能是凭据，
            // 把 false 替换成字符串会破坏恢复后的配置语义（回归：includeSessions 曾被误伤）
            out[k] =
              typeof val === "object" && val !== null
                ? walk(val, k)
                : typeof val === "string"
                  ? "__REDACTED__"
                  : val;
          } else {
            out[k] = walk(val, k);
          }
        }
        return out;
      }
      if (aggressiveValues && looksSecret(v)) return "__REDACTED__";
      return v;
    };
    return walk(obj);
  };

  // 按前缀匹配（见 isRedactable 注释）：
  //   auth.json           → auth.json / auth.json.bak-* / auth.json.tmp
  //   webdav-backup.json  → 同上
  // 早期实现只做 basename === "auth.json" 精确匹配，导致 auth.json.bak-*
  // 这类副本绕过脱敏，把明文密钥随备份上传到云端。
  if (base.startsWith("auth.json")) {
    try {
      const obj = JSON.parse(buf.toString("utf8"));
      const walkCredential = (cred) => {
        if (!cred || typeof cred !== "object") return redactJson(cred, { aggressiveValues: aggressive });
        const out = {};
        for (const [k, val] of Object.entries(cred)) {
          if (k === "key") {
            // 保留引用形式（如 $PI_PI_KEY_DEEPSEEK）——它是可恢复的非秘密指针，
            // 抹掉反而会丢失“密钥放在哪”的信息；真正的明文才需要处理
            out[k] = isRef(val) ? val : val === "" ? "" : "__REDACTED__";
            continue;
          }
          out[k] = redactJson(val, { aggressiveValues: aggressive });
        }
        return out;
      };

      const result = {};
      for (const [provider, cred] of Object.entries(obj)) {
        result[provider] = walkCredential(cred);
      }
      return Buffer.from(JSON.stringify(result, null, 2), "utf8");
    } catch {
      // 解析不了就不能冒险上传原文
      return Buffer.from("__REDACTED_UNPARSEABLE_AUTH_JSON__", "utf8");
    }
  }

  if (base.startsWith("webdav-backup.json")) {
    try {
      const obj = JSON.parse(buf.toString("utf8"));
      const cleaned = redactJson(obj, { aggressiveValues: false });
      // 与 auth.json 同一约定：密钥引用保留（指针非秘密），
      // 明文由字段名规则抹掉，这里只需把被误抹的引用还原
      if (typeof obj.encryptKey === "string" && isRef(obj.encryptKey)) cleaned.encryptKey = obj.encryptKey;
      const pw = obj.remote && typeof obj.remote === "object" ? obj.remote.password : undefined;
      if (typeof pw === "string" && isRef(pw) && cleaned.remote) cleaned.remote.password = pw;
      return Buffer.from(JSON.stringify(cleaned, null, 2), "utf8");
    } catch {
      return buf;
    }
  }

  return null;
}

/**
 * 脱敏后的二次保险：扫描【即将上传的实际内容】，确认没有明文凭据漏网。
 *
 * 为什么需要：脱敏是白名单逻辑，一旦出现未预设的文件名
 * （如 auth.json.bak-2026-...），就可能整文件放行。这个审计作为
 * 独立于白名单的第二道防线。
 *
 * 关键：必须审计“脱敏后”的内容，而不是磁盘原文——
 * auth.json / webdav-backup.json 是在写入归档时才脱敏的，
 * 拿磁盘原文去审计会把它们误报为泄露。
 *
 * @returns {{clean: boolean, leaks: {rel: string, reason: string}[]}}
 */
export function auditForPlaintext(files, opts = {}) {
  const { agentDir, config, readFile = readFileSync } = opts;
  const leaks = [];

  const SUSPICIOUS = [
    /"key"\s*:\s*"(?!\$|!|dpapi:|file:|__REDACTED)([A-Za-z0-9_\-]{16,})"/,
    /"password"\s*:\s*"(?!\$|!|dpapi:|file:|__REDACTED)([^"\s]{6,})"/,
    /"encryptKey"\s*:\s*"(?!\$|!|dpapi:|file:|__REDACTED)([^"\s]{6,})"/,
    /sk-[A-Za-z0-9_-]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
  ];

  for (const f of files) {
    const base = f.rel.split("/").pop() ?? "";

    // 凭据存储文件根本不该出现在待上传列表里（排除规则应已拦住）
    if (looksCredentialFile(f.rel)) {
      const isAuditable =
        base.startsWith("auth.json") || base.startsWith("webdav-backup.json");
      if (!isAuditable) {
        leaks.push({ rel: f.rel, reason: "凭据类文件未被排除" });
        continue;
      }
    }

    // 只审计小体量的文本/配置类文件，避免把整个仓库读进内存
    const isKeyFile =
      base.startsWith("auth.json") ||
      base.startsWith("webdav-backup.json") ||
      /(\.json|\.env|\.txt|\.ini|\.conf|\.cfg|\.toml|\.ya?ml|\.ts|\.js|\.mjs)$/i.test(f.rel);
    if (!isKeyFile) continue;
    if (f.size > 2 * 1024 * 1024) continue;

    let text;
    try {
      text = readFile(join(agentDir, f.rel), "utf8");
    } catch {
      continue;
    }
    if (typeof text !== "string") continue;

    // 对会被脱敏的文件，审计脱敏后的内容（即真正上传的字节）
    const redacted = redactSensitive(f.rel, Buffer.from(text, "utf8"), {
      aggressive: config ? !config.encrypt : true,
    });
    if (redacted) text = redacted.toString("utf8");

    for (const re of SUSPICIOUS) {
      const m = re.exec(text);
      if (m) {
        leaks.push({ rel: f.rel, reason: `疑似明文凭据：${m[0].slice(0, 40)}***` });
        break;
      }
    }
  }

  return { clean: leaks.length === 0, leaks };
}

/**
 * 文件名是否可能包含明文凭据。
 */
export function looksCredentialFile(relPath) {
  const base = String(relPath).split("/").pop() ?? "";
  const p = String(relPath).replace(/\\/g, "/");
  if (base.startsWith("auth.json")) return true;
  if (base.startsWith("webdav-backup.json")) return true;
  if (p === "secrets.dpapi.json") return true;
  if (p.startsWith("secrets/")) return true;
  return false;
}

/**
 * 执行备份。
 * @param {object} config  由 loadConfig() 得到的 config
 * @param {object} opts
 * @param {(msg: string) => void} [opts.log]
 * @param {string} opts.agentDir
 * @param {string} opts.stateFile
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.reason]  "manual" | "exit"
 */
export async function runBackup(config, opts) {
  const log = opts.log ?? (() => {});
  const agentDir = opts.agentDir;
  const stateFile = opts.stateFile;
  const snapshot = config.snapshot === true;
  const exclude = [...config.exclude];
  if (!config.includeSessions) exclude.push("sessions/**");
  if (config.encrypt) exclude.push("**/*.pibak");

  const t0 = Date.now();
  log(`扫描文件… (范围: ${config.scope.join(", ")})`);
  const { files, skipped, totalSize } = collectFiles({ agentDir, scope: config.scope, exclude });

  if (files.length === 0) {
    return { ok: false, error: "没有需要备份的文件（检查 scope 与 exclude 配置）", files: 0 };
  }
  log(`发现 ${files.length} 个文件，共 ${(totalSize / 1024 / 1024).toFixed(2)} MB（跳过 ${skipped} 项）`);

  // 未加密上传时，先审计是否还有明文凭据漏网（脱敏白名单之外的第二道防线）
  if (!config.encrypt) {
    const audit = auditForPlaintext(files, { agentDir, config });
    if (!audit.clean) {
      const detail = audit.leaks.map((l) => `  ${l.rel} — ${l.reason}`).join("\n");
      const msg =
        `检测到可能的明文凭据，已中止上传（避免密钥泄露到云端）：\n${detail}\n` +
        `处理方式：开启 encrypt（加密备份），或把上述文件加入 exclude。`;
      log(msg.replace(/\n/g, "\n  "));
      return { ok: false, error: msg, files: files.length, leaks: audit.leaks };
    }
  }

  const client = new WebDAVClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    timeoutMs: config.timeoutMs,
    insecureTls: config.insecureTls,
  });

  const check = await client.check();
  if (!check.ok) {
    return { ok: false, error: `WebDAV 连接失败：${check.error}`, files: 0 };
  }

  if (opts.dryRun) {
    const audit = auditForPlaintext(files, { agentDir, config });
    return {
      ok: true,
      dryRun: true,
      files: files.length,
      totalSize,
      skipped,
      elapsedMs: Date.now() - t0,
      plaintextAudit: audit.clean ? "clean" : audit.leaks,
    };
  }

  await client.mkdirp(config.remoteDir);
  const baseDir = config.remoteDir;

  if (snapshot) {
    return await runSnapshot({ client, config, files, totalSize, skipped, baseDir, agentDir, log, t0, stateFile });
  }
  return await runArchive({ client, config, files, totalSize, skipped, baseDir, agentDir, log, t0, stateFile });
}

/** 脱敏时的上下文：未加密上传时必须更激进 */
function redactOpts(config) {
  return { aggressive: !config.encrypt };
}

/** 归档模式：一个 tar.gz（可选加密）整体上传 */
async function runArchive({ client, config, files, totalSize, skipped, baseDir, agentDir, log, t0, stateFile }) {
  const tmpName = `pi-backup-${randomBytes(6).toString("hex")}`;
  const tmpDir = join(tmpdir(), tmpName);
  mkdirSync(tmpDir, { recursive: true });
  const plainTar = join(tmpDir, "payload.tar.gz");
  const ts = timestamp();
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    agentDir,
    scope: config.scope,
    includeSessions: !!config.includeSessions,
    encrypted: !!config.encrypt,
    totalSize,
    fileCount: files.length,
    files: files.map((f) => ({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs })),
  };

  try {
    log("打包中…");
    const rawTar = join(tmpDir, "payload.tar");
    const tarOut = createWriteStream(rawTar);
    const tar = new TarWriter(tarOut);
    let redactedCount = 0;

    for (const f of files) {
      // 配置文件本身脱敏后写入；其余正常写入
      const isSelfConfig = f.rel === "webdav-backup.json" || f.rel.endsWith("/webdav-backup.json");
      if (isRedactable(f.rel)) {
        try {
          const raw = readFileSync(f.abs);
          const redacted = redactSensitive(f.rel, raw, redactOpts(config));
          if (redacted) {
            await tar.addBuffer(redacted, f.rel, f.mtimeMs);
            redactedCount++;
            continue;
          }
        } catch {
          /* 读取失败则按原样 */
        }
      }
      await tar.addFile(f.abs, f.rel, f);
    }
    // 附带 manifest 便于恢复时对照
    await tar.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), ".pi-backup-manifest.json");
    await tar.finish();

    log(`压缩中…${redactedCount > 0 ? `（已脱敏 ${redactedCount} 个敏感文件）` : ""}`);
    await pipeline(createReadStream(rawTar), createGzip({ level: 6 }), createWriteStream(plainTar));

    const plainSize = statSync(plainTar).size;
    let uploadFile = plainTar;
    const baseName = `${config.remoteName}-${ts}.tar.gz`;
    const remoteFileName = config.encrypt ? `${baseName}.pibak` : baseName;
    const plainSha = await sha256File(plainTar);

    if (config.encrypt) {
      log("加密中…");
      const encFile = join(tmpDir, "payload.tar.gz.pibak");
      await encryptFile(plainTar, encFile, String(config.encryptKey), {
        name: remoteFileName,
        agentDir,
      });
      uploadFile = encFile;
    }

    const uploadSize = statSync(uploadFile).size;
    const remotePath = `${baseDir}/${remoteFileName}`;
    log(`上传中… ${remoteFileName} (${(uploadSize / 1024 / 1024).toFixed(2)} MB)`);
    await client.put(remotePath, readFileSync(uploadFile), {
      contentType: config.encrypt ? "application/octet-stream" : "application/gzip",
    });

    // 一并上传 manifest（未加密，便于快速查看历史）
    try {
      await client.put(
        `${baseDir}/manifest-${ts}.json`,
        Buffer.from(JSON.stringify({ ...manifest, archive: remoteFileName, plainSha256: plainSha, archiveSize: uploadSize }, null, 2), "utf8"),
        { contentType: "application/json" },
      );
    } catch {
      /* manifest 上传失败不视为备份失败 */
    }

    const elapsedMs = Date.now() - t0;
    writeState(stateFile, {
      lastBackupAt: new Date().toISOString(),
      lastReason: "archive",
      remotePath,
      files: files.length,
      redacted: redactedCount,
    });

    log(`完成：${remotePath} 用时 ${(elapsedMs / 1000).toFixed(1)}s`);
    return {
      ok: true,
      mode: "archive",
      remotePath,
      archive: remoteFileName,
      files: files.length,
      skipped,
      totalSize,
      archiveSize: uploadSize,
      plainSize,
      redacted: redactedCount,
      elapsedMs,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 快照模式：逐文件上传 + manifest 增量 */
async function runSnapshot({ client, config, files, totalSize, skipped, baseDir, agentDir, log, t0, stateFile }) {
  const dir = `${baseDir}/${config.remoteName}`;
  await client.mkdirp(dir);
  log("读取远端清单…");

  let prev = {};
  try {
    const raw = await client.get(`${dir}/manifest.json`);
    if (raw) {
      const parsed = JSON.parse(raw.toString("utf8"));
      for (const f of parsed.files ?? []) prev[f.rel] = f;
    }
  } catch {
    /* 无历史清单则全量 */
  }

  const uploaded = [];
  const skippedSame = [];
  const manifestFiles = [];

  for (const f of files) {
    const remotePath = `${dir}/${f.rel}`;
    const prevEntry = prev[f.rel];
    const isSelf = f.rel === "webdav-backup.json" || f.rel.endsWith("/webdav-backup.json");
    const isAuth = f.rel === "auth.json" || f.rel.startsWith("auth.json") || f.rel.endsWith("/auth.json");

    // 增量判断：大小与 mtime 都一致则跳过（auth.json / 配置总是重新上传，因为会脱敏）
    if (prevEntry && prevEntry.size === f.size && prevEntry.mtimeMs === f.mtimeMs && !isAuth && !isSelf) {
      skippedSame.push(f.rel);
      manifestFiles.push(prevEntry);
      continue;
    }

    let payload = readFileSync(f.abs);
    let stored = f;
    if (isRedactable(f.rel)) {
      const redacted = redactSensitive(f.rel, payload, redactOpts(config));
      if (redacted) {
        payload = redacted;
        stored = { ...f, size: redacted.length };
      }
    }

    const parts = f.rel.split("/");
    if (parts.length > 1) await client.mkdirp(`${dir}/${parts.slice(0, -1).join("/")}`);

    log(`  上传 ${f.rel} (${(payload.length / 1024).toFixed(1)} KB)`);
    await client.put(remotePath, payload, { contentType: "application/octet-stream" });
    uploaded.push(f.rel);
    manifestFiles.push({ rel: f.rel, size: stored.size, mtimeMs: f.mtimeMs, sha256: sha256Buffer(payload) });
  }

  const manifest = {
    version: 1,
    mode: "snapshot",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agentDir,
    scope: config.scope,
    includeSessions: !!config.includeSessions,
    totalSize,
    fileCount: files.length,
    files: manifestFiles,
  };
  await client.put(`${dir}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), {
    contentType: "application/json",
  });

  const elapsedMs = Date.now() - t0;
  writeState(stateFile, {
    lastBackupAt: new Date().toISOString(),
    lastReason: "snapshot",
    remoteDir: dir,
    files: files.length,
    uploaded: uploaded.length,
  });

  log(`完成：上传 ${uploaded.length} 个，跳过 ${skippedSame.length} 个未变化文件，用时 ${(elapsedMs / 1000).toFixed(1)}s`);
  return {
    ok: true,
    mode: "snapshot",
    remoteDir: dir,
    files: files.length,
    uploaded: uploaded.length,
    skippedSame: skippedSame.length,
    skipped,
    totalSize,
    elapsedMs,
  };
}

/** 清理旧版本，只保留最近 N 个归档（仅限当前 remoteName 前缀，不动其他前缀的备份） */
export async function pruneOldArchives(config, keep, log = () => {}) {
  if (!keep || keep <= 0) return { ok: true, deleted: [] };
  const client = new WebDAVClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    timeoutMs: config.timeoutMs,
    insecureTls: config.insecureTls,
  });
  await client.mkdirp(config.remoteDir);
  const entries = await client.list(config.remoteDir);
  const isArchive = archiveNameRe(config.remoteName);
  const archives = entries
    .filter((e) => !e.isCollection && isArchive.test(e.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // 名称含时间戳，倒序即从新到旧

  const toDelete = archives.slice(keep);
  const deleted = [];
  for (const a of toDelete) {
    await client.del(`${config.remoteDir}/${a.name}`);
    deleted.push(a.name);
    log(`  已删除旧备份 ${a.name}`);
  }
  return { ok: true, deleted, kept: archives.length - deleted.length };
}
