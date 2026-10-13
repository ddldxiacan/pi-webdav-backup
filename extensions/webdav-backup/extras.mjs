/**
 * extras.mjs — agentDir 之外的额外数据（`extra/**`）的归档、映射与归位
 *
 * 背景：pi 的 agentDir 默认是 ~/.pi/agent，但有些配置/插件数据写在别处：
 *   ~/.pi/settings.json                 （旧版 pi 遗留的包声明）
 *   ~/.pi/web-search.json               （pi-web-access 的回退位置）
 *   ~/.config/rpiv-<name>/config.json   （XDG 配置，rpiv-* 插件）
 * 这些路径通过 webdav-backup.json 的 extraScope 被打进归档的 `extra/` 前缀下。
 *
 * 跨机可移植（本模块核心）：
 *   备份时记录 `extra-manifest.json`，标明每个文件“来自哪个锚点”（home / config / appdata）
 *   以及相对锚点的尾巴。恢复时按【当前机器】的锚点重算目标路径：
 *     旧机 /home/alice/.pi/settings.json  →  新机 /home/bob/.pi/settings.json
 *     旧机 C:/Users/alice/.pi/settings.json → 新机 D:/Users/carol/.pi/settings.json
 *   不在任何锚点下的绝对路径（如 /etc/foo）保持原样，并标记为“未映射”以便提醒。
 *
 * 安全：只识别本工具生成的 extra/ 布局；目标路径由锚点 + 尾巴拼出，拒绝 .. 穿越。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname, resolve, sep } from "node:path";

export const EXTRA_PREFIX = "extra/";
export const EXTRA_MANIFEST_NAME = "extra-manifest.json";

/** 归档内统一用 `/` 分隔 */
function norm(p) {
  return String(p).replace(/\\/g, "/");
}

/** child 是否在 parent 之下；返回尾巴（相对 parent），否则 null。Windows 大小写不敏感。 */
function stripPrefix(child, parent) {
  const c = norm(child);
  const p = norm(parent).replace(/\/+$/, "");
  if (!p) return null;
  const ci = process.platform === "win32";
  const cc = ci ? c.toLowerCase() : c;
  const pp = ci ? p.toLowerCase() : p;
  if (cc === pp) return "";
  if (cc.startsWith(`${pp}/`)) return c.slice(p.length + 1);
  return null;
}

/** 把锚点尾巴拼成当前机器的原生绝对路径（拒绝 .. 穿越） */
function nativeJoin(root, tail) {
  const parts = String(tail)
    .split("/")
    .filter((s) => s && s !== "." && s !== "..");
  return join(root, ...parts);
}

/**
 * 把 agentDir 之外的绝对路径映射成归档内安全、无歧义的相对路径。
 *   C:\Users\me\.pi\settings.json → extra/C/Users/me/.pi/settings.json
 *   /home/me/.pi/settings.json    → extra/home/me/.pi/settings.json
 */
export function extraArchivePath(absPath) {
  let p = norm(resolve(String(absPath)));
  p = p.replace(/^([A-Za-z]):\//, "$1/"); // 去掉盘符后的冒号，保留盘符作为首段
  const segs = p.split("/").filter((s) => s && s !== "." && s !== "..");
  return `${EXTRA_PREFIX}${segs.join("/")}`;
}

/** 该额外路径是否是“配置/数据类”文件（值得一并脱敏保护） */
export function isDataLikeExtraPath(absPath) {
  const b = norm(absPath).split("/").pop() ?? "";
  const lower = b.toLowerCase();
  return (
    lower.endsWith(".json") ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /\.(ya?ml|toml|ini|conf|cfg|txt)$/i.test(lower) ||
    ["config", "config.json", "settings", "auth", "secret", "secrets", "credentials"].includes(lower)
  );
}

/** 当前机器上各锚点（锚点种类 → 真实根目录） */
export function currentAnchors() {
  const home = resolve(homedir());
  const config = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(home, ".config");
  const out = [
    { kind: "home", path: home },
    { kind: "config", path: config },
  ];
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ? resolve(process.env.APPDATA) : join(home, "AppData", "Roaming");
    out.push({ kind: "appdata", path: appdata });
  }
  // 去重（config 常与 home 重合），保留路径最长者优先的顺序
  const seen = new Set();
  return out.filter((a) => {
    const k = norm(a.path).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 备份侧：把绝对路径转成可移植表示（供展示/调试；恢复实际按锚点重算） */
export function toPortable(absPath, anchors = currentAnchors()) {
  const p = norm(absPath);
  let best = null;
  for (const a of anchors) {
    const tail = stripPrefix(p, a.path);
    if (tail !== null && (!best || a.path.length > best.path.length)) best = { a, tail };
  }
  if (!best) return p;
  return best.a.kind === "home" ? `~/${best.tail}` : `{${best.a.kind}}/${best.tail}`;
}

/**
 * 备份侧：根据已收集的文件构建 extra 映射清单。
 * @param {{rel: string, abs: string}[]} files collectFiles 的结果
 * @returns {{version: number, createdAt: string, source: object, entries: object[]}}
 */
export function buildExtraMap(files, opts = {}) {
  const anchors = opts.anchors ?? currentAnchors();
  const entries = [];
  for (const f of files) {
    const rel = norm(f.rel);
    if (!rel.startsWith(EXTRA_PREFIX)) continue;
    const orig = norm(f.abs);
    entries.push({ rel, orig, portable: toPortable(orig, anchors) });
  }
  // 只保留确有文件落入的锚点
  const used = anchors.filter((a) => entries.some((e) => stripPrefix(e.orig, a.path) !== null));
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    source: {
      platform: process.platform,
      hostname: hostname(),
      home: opts.home ?? norm(resolve(homedir())),
      anchors: used.map((a) => ({ kind: a.kind, path: norm(a.path) })),
    },
    entries,
  };
}

/**
 * 恢复侧：把一个 entry 解析成【当前机器】上的目标绝对路径。
 * 优先用源锚点重算；无法映射时退回 orig 原样。
 * @returns {{target: string|null, mapped: boolean, anchor: string|null}}
 */
export function resolveExtraEntry(entry, source, opts = {}) {
  const orig = entry?.orig ? norm(entry.orig) : null;
  if (!orig) return { target: null, mapped: false, anchor: null };

  const srcAnchors = Array.isArray(source?.anchors) ? source.anchors : [];
  const cur = new Map((opts.anchors ?? currentAnchors()).map((a) => [a.kind, a.path]));

  let best = null;
  for (const a of srcAnchors) {
    const tail = stripPrefix(orig, a.path);
    if (tail !== null && (!best || norm(a.path).length > norm(best.path).length)) best = { a, tail };
  }
  if (best) {
    const root = cur.get(best.a.kind);
    if (root) return { target: nativeJoin(root, best.tail), mapped: true, anchor: best.a.kind };
  }
  // 兜底：按原绝对路径还原（可能因盘符/机器不同而不存在）
  return { target: orig.replace(/\//g, sep), mapped: false, anchor: null };
}

/**
 * 从归档内 `extra/**` 相对路径反推真实绝对路径（**旧版归档的兜底**）。
 * 新归档请走 resolveExtraEntry（支持跨机重映射）。
 */
export function extraPathToAbsolute(rel) {
  const r = norm(rel);
  if (!r.startsWith(EXTRA_PREFIX)) return null;
  const segs = r.slice(EXTRA_PREFIX.length).split("/").filter((s) => s && s !== "." && s !== "..");
  if (segs.length === 0) return null;

  if (process.platform === "win32") {
    if (!/^[A-Za-z]$/.test(segs[0])) return null;
    return `${segs[0]}:/${segs.slice(1).join("/")}`;
  }
  return `/${segs.join("/")}`;
}

/** 读取恢复目录里的 extra-manifest.json（不存在/损坏返回 null） */
export function readExtraManifest(restoredDir) {
  const p = join(restoredDir, EXTRA_MANIFEST_NAME);
  try {
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * 递归收集 restoredDir/extra 下的所有文件。
 * 若存在 extra-manifest.json，则按锚点重算目标（跨机可移植）；否则退回旧版反推。
 * @returns {{rel: string, abs: string, target: string|null, orig: string|null, portable: string|null, mapped: boolean, anchor: string|null}[]}
 */
export function listExtraFiles(restoredDir, opts = {}) {
  const root = join(restoredDir, EXTRA_PREFIX.replace(/\/$/, ""));
  const out = [];
  if (!existsSync(root)) return out;

  const manifest = readExtraManifest(restoredDir);
  const byRel = new Map();
  if (manifest?.entries) {
    for (const e of manifest.entries) byRel.set(norm(e.rel), e);
  }

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = `${EXTRA_PREFIX}${full.slice(root.length + 1).split(sep).join("/")}`;
        const entry = byRel.get(rel);
        let target = null;
        let mapped = false;
        let anchor = null;
        if (entry?.orig) {
          const r = resolveExtraEntry(entry, manifest.source, opts);
          target = r.target;
          mapped = r.mapped;
          anchor = r.anchor;
        } else {
          target = extraPathToAbsolute(rel);
        }
        out.push({
          rel,
          abs: full,
          target,
          orig: entry?.orig ?? null,
          portable: entry?.portable ?? null,
          mapped,
          anchor,
        });
      }
    }
  };
  walk(root);
  return out;
}

function sameContent(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (!sa.isFile() || !sb.isFile()) return false;
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** 源（恢复出来的）是否含脱敏占位符 */
function hasRedaction(buf) {
  try {
    return buf.includes(Buffer.from("__REDACTED__"));
  } catch {
    return false;
  }
}

/** 覆盖前把现有文件另存为 <name>.bak-<tag>-<ts>，避免不可逆丢失 */
function backupExisting(target, tag = "extras") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${target}.bak-${tag}-${ts}`;
  try {
    writeFileSync(bak, readFileSync(target));
    return bak;
  } catch {
    return null;
  }
}

export { sameContent, hasRedaction, backupExisting };

/**
 * 把 extra/ 的文件归位到真实路径（跨机按锚点重映射）。
 * @param {string} restoredDir 恢复出来的目录
 * @param {{log?: Function, dryRun?: boolean, only?: string[], force?: boolean}} opts
 * @returns {{ok: boolean, applied: Array, skipped: Array, unchanged: Array, failed: Array, unparsed: Array, unmapped: Array, source: object|null}}
 */
export function applyExtraFiles(restoredDir, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const only = opts.only ? new Set(opts.only) : null;

  const manifest = readExtraManifest(restoredDir);
  const files = listExtraFiles(restoredDir, opts);
  const applied = [];
  const skipped = [];
  const unchanged = [];
  const failed = [];
  const unparsed = [];
  const unmapped = [];

  for (const f of files) {
    if (only && !only.has(f.rel)) continue;
    if (!f.target) {
      unparsed.push({ rel: f.rel, reason: "无法从归档路径反推目标位置" });
      continue;
    }
    // 有 orig 但未能用锚点重映射 → 目标仍是旧机的绝对路径，提醒用户
    if (f.orig && !f.mapped) {
      unmapped.push({ rel: f.rel, orig: f.orig, target: f.target });
    }
    const target = resolve(f.target);

    // 已存在且内容一致 → 无需处理
    if (existsSync(target) && sameContent(f.abs, target)) {
      unchanged.push({ rel: f.rel, target: f.target });
      continue;
    }

    // 安全防护：源含脱敏占位符，而本地目标已有“真实值”时，
    // 直接覆盖会把真秘密换成 __REDACTED__（同机误操作会弄坏配置）。
    // 除非显式 --force，否则跳过。
    if (!force && existsSync(target)) {
      const src = readFileSync(f.abs);
      if (hasRedaction(src)) {
        const local = readFileSync(target);
        if (!hasRedaction(local)) {
          skipped.push({
            rel: f.rel,
            target: f.target,
            reason: "本地已有真实值，跳过以免用脱敏占位覆盖（加 --force 强制）",
          });
          continue;
        }
      }
    }

    if (dryRun) {
      skipped.push({ rel: f.rel, target: f.target, reason: "dry-run" });
      continue;
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target) && lstatSync(target).isDirectory()) {
        failed.push({ rel: f.rel, target: f.target, error: "目标是一个目录，拒绝覆盖" });
        continue;
      }
      let backup = null;
      if (existsSync(target)) backup = backupExisting(target);
      writeFileSync(target, readFileSync(f.abs));
      applied.push({ rel: f.rel, target: f.target, orig: f.orig, mapped: f.mapped, backup });
      log(`  已归位 ${f.rel} → ${f.target}${f.mapped ? "（跨机重映射）" : ""}${backup ? `（原文件已备份为 ${backup}）` : ""}`);
    } catch (e) {
      failed.push({ rel: f.rel, target: f.target, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    ok: failed.length === 0,
    applied,
    skipped,
    unchanged,
    failed,
    unparsed,
    unmapped,
    source: manifest?.source ?? null,
  };
}

/**
 * 探测 agentDir 之外、但可能影响插件加载的遗留配置文件。
 * 现在识别：
 *   <parent>/settings.json —— pi 旧版本 / 某些工具写在 ~/.pi/settings.json 的包声明
 *   <parent>/web-search.json —— pi-web-access 的回退位置
 * 只读探测，不修改。
 */
export function detectLegacyConfig(agentDir) {
  const out = [];
  const parent = dirname(resolve(agentDir));
  const candidates = [
    { path: join(parent, "settings.json"), kind: "legacy-settings", note: "与 agentDir 同级（如 ~/.pi/settings.json）" },
    { path: join(parent, "web-search.json"), kind: "web-search", note: "pi-web-access 的回退位置" },
  ];
  for (const c of candidates) {
    try {
      if (!existsSync(c.path)) continue;
      const st = statSync(c.path);
      if (!st.isFile()) continue;
      let packages = null;
      if (c.kind === "legacy-settings") {
        try {
          const j = JSON.parse(readFileSync(c.path, "utf8").replace(/^\uFEFF/, ""));
          packages = Array.isArray(j?.packages) ? j.packages.map(String) : [];
        } catch {
          packages = null;
        }
      }
      out.push({ ...c, size: st.size, packages, portable: toPortable(c.path) });
    } catch {
      /* ignore */
    }
  }
  return out;
}
