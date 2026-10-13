/**
 * webdav.mjs — 极简 WebDAV 客户端（零依赖，基于 node:http/https）
 *
 * 支持：MKCOL、PUT、GET、DELETE、PROPFIND、HEAD
 * 认证：Basic Auth / Digest 不实现（WebDAV 主流服务用 Basic + TLS 或应用密码）
 *
 * 重定向：GET/HEAD 的 301/302/303/307/308 会自动跟随（最多 MAX_REDIRECTS 跳）。
 *   Cloudreve 等网盘把 GET 重定向到对象存储（如腾讯云 COS）的带签名临时 URL，
 *   不跟随就会拿到 302 而恢复失败。跳到其他主机时会丢弃 Authorization 头，
 *   避免把 WebDAV 凭据泄露给对象存储。
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const UA = "pi-webdav-backup/1.0";
const MAX_REDIRECTS = 5;

/**
 * 瞬时错误重试参数。
 *
 * 背景：网盘（坚果云/群晖/Cloudreve 等）在并发上传、扫描或维护时会返回
 * 423 Locked / 429 / 5xx；同一文件在稍后重试即可成功。之前没有任何重试，
 * 一次抖动就导致整次备份失败（实测：两个实例同时退出备份 → 423）。
 */
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 800;
const RETRYABLE_STATUS = new Set([423, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(["PUT", "MKCOL", "DELETE", "PROPFIND", "HEAD", "GET"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析 Retry-After（秒数或 HTTP 日期），返回毫秒；无法解析返回 null */
function parseRetryAfter(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

function request(url, { method, headers = {}, body = null, timeoutMs = 60000, insecureTls = false, redirects = MAX_REDIRECTS }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(`非法 URL: ${url} (${e.message})`));
      return;
    }

    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;

    /** @type {import("node:http").RequestOptions} */
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { "User-Agent": UA, ...headers },
      agent: false,
    };
    if (isHttps && insecureTls) opts.rejectUnauthorized = false;

    const req = lib.request(opts, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      const isRedirect = [301, 302, 303, 307, 308].includes(status);

      // 跟随重定向（仅 GET/HEAD；PUT/DELETE/PROPFIND 不跟随，避免意外丢方法体）
      if (isRedirect && location && redirects > 0 && (method === "GET" || method === "HEAD")) {
        res.resume(); // 丢弃重定向响应体，释放连接
        let next;
        try {
          next = new URL(location, url);
        } catch (e) {
          reject(new Error(`${method} ${url} 重定向地址非法: ${location} (${e.message})`));
          return;
        }
        // 跨主机重定向到对象存储时，不能把 WebDAV 凭据带过去
        const nextHeaders = { ...headers };
        const nextPort = Number(next.port || (next.protocol === "https:" ? 443 : 80));
        if (next.hostname !== u.hostname || nextPort !== Number(opts.port)) delete nextHeaders.Authorization;
        // 303 语义：后续一律 GET
        const nextMethod = status === 303 ? "GET" : method;
        request(next.toString(), {
          method: nextMethod,
          headers: nextHeaders,
          body: null,
          timeoutMs,
          insecureTls,
          redirects: redirects - 1,
        }).then(resolve, reject);
        return;
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 (${timeoutMs}ms): ${method} ${url}`));
    });
    req.on("error", (e) => reject(new Error(`${method} ${url} 失败: ${e.message}`)));

    if (body) req.write(body);
    req.end();
  });
}

function basicAuth(username, password) {
  if (!username && !password) return {};
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

/**
 * 带重试的请求：对 423/429/5xx 与网络抖动指数据退避重试（仅幂等方法）。
 * PUT 幂等（整体覆盖同名文件），故也可安全重试。
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
async function requestWithRetry(url, opts) {
  const method = String(opts.method || "GET").toUpperCase();
  const retryable = RETRYABLE_METHODS.has(method);
  let lastRes = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await request(url, opts);
    } catch (e) {
      // 网络层错误（超时/断连）也重试
      if (!retryable || attempt === MAX_RETRIES) throw e;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }
    lastRes = res;
    if (!retryable || !RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) return res;
    const hinted = parseRetryAfter(res.headers?.["retry-after"]);
    const delay = hinted ?? RETRY_BASE_DELAY_MS * 2 ** attempt;
    await sleep(Math.min(delay, 15000));
  }
  return lastRes;
}

export class WebDAVClient {
  constructor({ baseUrl, username, password, timeoutMs = 60000, insecureTls = false }) {
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`WebDAV 地址必须以 http(s):// 开头：${baseUrl}`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = basicAuth(username, password);
    this.timeoutMs = timeoutMs;
    this.insecureTls = insecureTls;
  }

  /** 拼接远端绝对 URL 路径 */
  urlFor(remotePath) {
    const clean = String(remotePath)
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => encodeURIComponent(s))
      .join("/");
    return clean ? `${this.baseUrl}/${clean}` : this.baseUrl;
  }

  async #req(method, remotePath, { headers = {}, body = null } = {}) {
    return requestWithRetry(this.urlFor(remotePath), {
      method,
      headers: { ...this.auth, ...headers },
      body,
      timeoutMs: this.timeoutMs,
      insecureTls: this.insecureTls,
    });
  }

  /** 连通性与认证检查 */
  async check() {
    const res = await this.#req("PROPFIND", "", {
      headers: { Depth: "0", "Content-Type": "application/xml" },
    });
    if (res.status === 207 || res.status === 200) return { ok: true, status: res.status };
    if (res.status === 401) return { ok: false, status: 401, error: "认证失败（401）：用户名或密码/应用密码不对" };
    if (res.status === 403) return { ok: false, status: 403, error: "拒绝访问（403）：权限不足" };
    if (res.status === 404) return { ok: false, status: 404, error: "路径不存在（404）：检查 remote.url 是否写对" };
    return { ok: false, status: res.status, error: `未知响应 ${res.status}` };
  }

  /** 递归创建目录，返回是否全部成功 */
  async mkdirp(remotePath) {
    const parts = String(remotePath).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const res = await this.#req("MKCOL", cur);
      // 201 创建成功；405 已存在；301/302 部分服务端已存在
      if (![201, 405, 301, 302].includes(res.status)) {
        if (res.status === 409) {
          // 父目录不存在，继续尝试下一层（通常意味着上层创建失败）
          throw new Error(`创建目录失败 (409) : ${cur}`);
        }
        throw new Error(`创建目录 ${cur} 失败：HTTP ${res.status}`);
      }
    }
    return true;
  }

  async put(remotePath, buffer, { contentType = "application/octet-stream" } = {}) {
    const res = await this.#req("PUT", remotePath, {
      headers: { "Content-Type": contentType, "Content-Length": String(buffer.length) },
      body: buffer,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    throw new Error(`上传 ${remotePath.split("/").pop()} 失败：HTTP ${res.status} ${res.body.toString("utf8").slice(0, 200)}`);
  }

  async get(remotePath) {
    const res = await this.#req("GET", remotePath);
    if (res.status === 200) return res.body;
    if (res.status === 404) return null;
    const hint = [301, 302, 303, 307, 308].includes(res.status)
      ? "（服务端要求重定向到对象存储，可能跳转次数超限）"
      : "";
    throw new Error(`下载 ${remotePath} 失败：HTTP ${res.status}${hint}`);
  }

  async stat(remotePath) {
    const res = await this.#req("HEAD", remotePath);
    if (res.status === 200) {
      return {
        exists: true,
        size: Number(res.headers["content-length"] ?? 0),
        lastModified: res.headers["last-modified"] ?? null,
      };
    }
    if (res.status === 404) return { exists: false };
    // 有些服务端不支持 HEAD，降级为 PROPFIND
    const p = await this.#req("PROPFIND", remotePath, { headers: { Depth: "0" } });
    if (p.status === 207 || p.status === 200) {
      const text = p.body.toString("utf8");
      const size = /<D:getcontentlength>(\d+)<\/D:getcontentlength>/i.exec(text)?.[1]
        ?? /<getcontentlength[^>]*>(\d+)</i.exec(text)?.[1];
      const lm = /<D:getlastmodified>([^<]+)<\/D:getlastmodified>/i.exec(text)?.[1]
        ?? /<getlastmodified[^>]*>([^<]+)</i.exec(text)?.[1];
      return { exists: true, size: size ? Number(size) : 0, lastModified: lm ?? null };
    }
    if (p.status === 404) return { exists: false };
    throw new Error(`查询 ${remotePath} 失败：HTTP ${p.status}`);
  }

  async del(remotePath) {
    const res = await this.#req("DELETE", remotePath);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    if (res.status === 404) return { ok: true, status: 404 };
    throw new Error(`删除 ${remotePath} 失败：HTTP ${res.status}`);
  }

  /** 列出目录内文件（只解析 href 与 getcontentlength） */
  async list(remotePath) {
    const res = await this.#req("PROPFIND", remotePath, {
      headers: { Depth: "1", "Content-Type": "application/xml" },
    });
    if (res.status === 404) return [];
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`列出 ${remotePath} 失败：HTTP ${res.status}`);
    }
    const text = res.body.toString("utf8");
    const entries = [];
    const responseRe = /<(?:D:|d:|)[Rr]esponse>([\s\S]*?)<\/(?:D:|d:|)[Rr]esponse>/g;
    let m;
    while ((m = responseRe.exec(text))) {
      const block = m[1];
      const href =
        /<(?:D:|d:|)[Hh]ref>([^<]+)<\/(?:D:|d:|)[Hh]ref>/.exec(block)?.[1] ?? "";
      const size =
        /<(?:D:|d:|)getcontentlength>(\d+)<\/(?:D:|d:|)getcontentlength>/i.exec(block)?.[1] ??
        /<getcontentlength[^>]*>(\d+)</i.exec(block)?.[1];
      const lm =
        /<(?:D:|d:|)getlastmodified>([^<]+)<\/(?:D:|d:|)getlastmodified>/i.exec(block)?.[1] ??
        /<getlastmodified[^>]*>([^<]+)</i.exec(block)?.[1];
      const isCollection =
        /<(?:D:|d:|)resourcetype>\s*<(?:D:|d:|)collection/i.test(block) ||
        /<resourcetype[^>]*>\s*<collection/i.test(block);
      if (!href) continue;
      let name;
      try {
        name = decodeURIComponent(href.split("/").filter(Boolean).pop() ?? "");
      } catch {
        name = href.split("/").filter(Boolean).pop() ?? "";
      }
      entries.push({
        href,
        name,
        size: size ? Number(size) : 0,
        lastModified: lm ?? null,
        isCollection,
      });
    }
    return entries;
  }
}
