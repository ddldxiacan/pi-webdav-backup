/**
 * apply.mjs — 把「恢复出来的目录」写回当前 pi 的 agent 目录（换机一键还原）
 *
 * 背景：restore 默认只把归档解到一个临时目录，用户还得手动拷贝。换机场景下
 * 这正是最痛的一步。本模块负责把恢复结果安全地写回 ~/.pi/agent：
 *
 *   - 跳过 agentDir 之外的额外数据（extra/），它们由 apply-extras 单独归位
 *   - 跳过工具自身生成的文件（manifest / extra-manifest / state / log）
 *   - 覆盖前把现有文件另存为 <name>.bak-apply-<时间戳>，避免不可逆丢失
 *   - 源文件含 __REDACTED__ 而本地已有真实值时默认跳过（防止把真密钥覆盖成占位符）
 *   - 返回逐项结果，供上层汇总提示
 *
 * 恢复策略（merge）：
 *   新电脑往往已经装了一些插件。若直接覆盖，会丢声明、把同名插件降级、留下版本混合
 *   的“缝合”目录。所以默认走【合并】：
 *     - settings.json 只合并 packages：本机已有声明优先，追加备份里本机没有的插件
 *     - 本机已存在的插件实现（node_modules、git）保留本机版本，不用备份覆盖
 *     - 本机没有的插件则从备份补入
 *   想完全还原成旧机器（含删掉本机多装的插件、降级同名插件）用 merge=false / --mode replace。
 *
 * 只依赖 node 内置模块。
 */

import {
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { hasRedaction, backupExisting } from "./extras.mjs";
import { parsePackageSource } from "./packages.mjs";

/** 这些是备份/恢复流程自己产生的元数据，不应写回 agent 目录 */
const SKIP_NAMES = new Set([
  ".pi-backup-manifest.json",
  "extra-manifest.json",
  "webdav-backup-state.json",
  "webdav-backup.log",
]);

function safeJoin(destDir, rel) {
  const parts = String(rel)
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..");
  return join(destDir, ...parts);
}

function fileEqualsBuffer(target, buf) {
  try {
    return readFileSync(target).equals(buf);
  } catch {
    return false;
  }
}

/** 该相对路径是否属于「插件实现代码」（node_modules / git 包） */
export function isPluginImplementationPath(rel) {
  const r = String(rel).replace(/\\/g, "/");
  return r.startsWith("git/") || r.includes("/node_modules/");
}

/** agentDir 下的 npm 包清单（决定 pi 启动时 npm 装/卸哪些插件） */
export function isNpmManifestPath(rel) {
  return String(rel).replace(/\\/g, "/") === "npm/package.json";
}

/**
 * 求一个插件实现文件所属的「插件根目录」相对路径，用于判定本机是否已装该插件：
 *   npm/node_modules/foo/lib/x.js       → npm/node_modules/foo
 *   npm/node_modules/@scope/pkg/x.js    → npm/node_modules/@scope/pkg
 *   git/host/u/r/node_modules/dep/x.js  → git/host/u/r/node_modules/dep
 *   git/host/u/r/src/x.ts               → git/host/u/r（整仓一起判定）
 * 不在插件实现范围内则返回 null。
 */
export function pluginRootRel(rel) {
  const r = String(rel).replace(/\\/g, "/");
  const marker = "/node_modules/";
  const idx = r.lastIndexOf(marker);
  if (idx >= 0) {
    const after = r.slice(idx + marker.length).split("/");
    const pkg = after[0]?.startsWith("@") && after[1] ? `${after[0]}/${after[1]}` : after[0];
    if (!pkg) return null;
    return r.slice(0, idx + marker.length) + pkg;
  }
  if (r.startsWith("git/")) {
    const segs = r.split("/");
    // git/<host>/<user>/<repo...>：至少保留 host/user/repo 三段
    if (segs.length >= 4) return segs.slice(0, 4).join("/");
  }
  return null;
}

/**
 * 取 packages 声明的来源字符串（兼容字符串与 { source, ... } 对象）
 */
function packageSourceString(p) {
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof p.source === "string") return p.source;
  return null;
}

/**
 * 判断一条 packages 声明是否是「本机绝对路径」形式的本地源。
 *
 * 为何重要：`pi install /绝对/路径` 会把该机器的绝对路径写进 settings.json。
 * 跨平台/跨机器恢复时，这种路径在目标机上必然无效（且可能指到完全无关的位置），
 * 所以合并时要过滤掉，不要带过去。
 *
 * 只认「路径形」字符串；`npm:` / `git:` / `https://` / `builtin:` 等来源不受影响。
 * 注意：相对路径（如 `./ext`、`ext`）是可移植的，不过滤。
 */
export function isMachineSpecificPackagePath(source) {
  const s = packageSourceString(source);
  if (!s) return false;
  const v = s.trim();
  if (!v) return false;
  // 显式来源前缀：不是本地路径
  if (/^(npm:|git:|github:|https?:|ssh:|builtin:|file:)/i.test(v)) return false;
  // Windows 盘符绝对路径：C:\foo 或 C:/foo
  if (/^[A-Za-z]:[\\/]/.test(v)) return true;
  // UNC 路径：\\server\share
  if (/^\\\\/.test(v)) return true;
  // POSIX 绝对路径：/home/me/ext（含 \\home 形式的 Windows 风格根部）
  if (v.startsWith("/") || v.startsWith("\\\\")) return true;
  return false;
}

/**
 * 计算一条 packages 声明的「身份」：npm 看包名、git 看 host/path、local 看路径。
 * 用于合并时按身份去重（同身份视为同一个插件，不因版本号不同而重复）。
 */
export function packageIdentity(p) {
  const s = packageSourceString(p);
  if (!s) return null;
  const parsed = parsePackageSource(s);
  if (!parsed) return `raw:${s}`;
  if (parsed.type === "npm") return `npm:${parsed.name}`;
  if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
  return `local:${parsed.path}`;
}

/**
 * 合并 settings.json 的 packages 字段：本机已有声明优先，追加备份里本机没有的。
 * 返回合并后的 JSON 文本；无需合并（本机没有 packages）时返回 null，由调用方按普通逻辑处理。
 * 除 packages 外的字段以备份为准（这正是“恢复配置”的语义）。
 */
export function mergeSettingsPackages(backupText, localText) {
  let backup;
  let local;
  try {
    backup = JSON.parse(String(backupText).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  try {
    local = JSON.parse(String(localText).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!backup || typeof backup !== "object") return null;

  const backupPkgs = Array.isArray(backup.packages) ? backup.packages : [];
  const localPkgs = Array.isArray(local?.packages) ? local.packages : [];

  // 本机没有任何声明（新机场景）：用备份版，但仍过滤掉旧机器专属的绝对路径
  if (localPkgs.length === 0) {
    const kept = backupPkgs.filter((p) => !isMachineSpecificPackagePath(p));
    if (kept.length === backupPkgs.length) return null; // 无外来源，无需改写
    return JSON.stringify({ ...backup, packages: kept }, null, 2);
  }

  const localIds = new Set(localPkgs.map(packageIdentity).filter(Boolean));
  const extra = backupPkgs.filter((p) => {
    // 备份里指向旧机器绝对路径的本地源，在目标机上无效 → 不合并
    if (isMachineSpecificPackagePath(p)) return false;
    const id = packageIdentity(p);
    return id && !localIds.has(id);
  });

  return JSON.stringify({ ...backup, packages: [...localPkgs, ...extra] }, null, 2);
}

/**
 * 合并 npm/package.json 的 dependencies：本机已有优先（保留版本），追加备份里本机没有的。
 *
 * 为何必须合并：pi 启动时会拿 npm/package.json 与 node_modules 做协调（npm install）。
 * 若 merge 写回时用备份版直接覆盖，本机独有的插件会被 npm 当成多余包【卸载】。
 * 返回合并后的 JSON 文本；无可合并时返回 null（调用方按普通逻辑处理）。
 */
export function mergeNpmDependencies(backupText, localText) {
  let backup;
  let local;
  try {
    backup = JSON.parse(String(backupText).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  try {
    local = JSON.parse(String(localText).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!backup || typeof backup !== "object") return null;

  const backupDeps = backup.dependencies && typeof backup.dependencies === "object" ? backup.dependencies : {};
  const localDeps = local?.dependencies && typeof local.dependencies === "object" ? local.dependencies : {};
  if (Object.keys(localDeps).length === 0) return null;

  // 本机已声明的依赖保留本机版本；备份独有的追加进来
  const merged = { ...localDeps };
  let added = 0;
  for (const [name, range] of Object.entries(backupDeps)) {
    if (!(name in merged)) {
      merged[name] = range;
      added++;
    }
  }
  // 本机声明已包含备份全部依赖且无新增 → 无需改写
  if (added === 0 && Object.keys(merged).length === Object.keys(localDeps).length) return null;
  return JSON.stringify({ ...backup, dependencies: merged }, null, 2);
}

/** 递归列出恢复目录下、应写回 agentDir 的文件（跳过 extra/ 与元数据） */
export function listRestoredFiles(restoredDir, { extraPrefix = "extra/" } = {}) {
  const root = resolve(restoredDir);
  const out = [];
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        // agentDir 之外的额外数据走 apply-extras，不在这里重复写
        if (rel === extraPrefix.replace(/\/$/, "") || rel.startsWith(extraPrefix)) continue;
        if (SKIP_NAMES.has(ent.name)) continue;
        out.push({ rel, abs });
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * 把恢复目录写回 agentDir。
 * @param {string} restoredDir 恢复出来的目录
 * @param {string} agentDir    目标 agent 目录（通常 ~/.pi/agent）
 * @param {{log?: Function, dryRun?: boolean, force?: boolean, merge?: boolean, only?: string[]}} opts
 *   merge 默认 true：保护本机已装插件；false=完全覆盖替换（旧机器原样）。
 * @returns {{ok:boolean, applied:Array, unchanged:Array, skipped:Array, failed:Array, total:number, merged:Array}}
 */
export function applyRestoredFiles(restoredDir, agentDir, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const merge = opts.merge !== false; // 默认合并，保护本机已装插件
  const only = opts.only ? new Set(opts.only) : null;

  const files = listRestoredFiles(restoredDir);
  const applied = [];
  const unchanged = [];
  const skipped = [];
  const failed = [];
  const merged = [];

  if (!existsSync(agentDir) && !dryRun) mkdirSync(agentDir, { recursive: true });

  for (const f of files) {
    if (only && !only.has(f.rel)) continue;
    const target = safeJoin(agentDir, f.rel);

    let srcBuf;
    try {
      srcBuf = readFileSync(f.abs);
    } catch (e) {
      failed.push({ rel: f.rel, target, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // merge：settings.json 只合并 packages，保留本机已有的插件声明（避免删掉/降级本机插件）
    let mergedSettings = false;
    if (merge && f.rel === "settings.json" && existsSync(target)) {
      try {
        const mergedText = mergeSettingsPackages(srcBuf.toString("utf8"), readFileSync(target, "utf8"));
        if (mergedText !== null) {
          srcBuf = Buffer.from(mergedText, "utf8");
          mergedSettings = true;
        }
      } catch {
        /* 合并失败则退回普通处理 */
      }
    }

    // merge：npm/package.json 只合并 dependencies，保留本机独有插件。
    // 否则覆盖后，pi 下次启动的 npm 协调会把本机独有的包当成多余包卸载。
    let mergedNpm = false;
    if (merge && isNpmManifestPath(f.rel) && existsSync(target)) {
      try {
        const mergedText = mergeNpmDependencies(srcBuf.toString("utf8"), readFileSync(target, "utf8"));
        if (mergedText !== null) {
          srcBuf = Buffer.from(mergedText, "utf8");
          mergedNpm = true;
        }
      } catch {
        /* 合并失败则退回普通处理 */
      }
    }

    // merge：本机已装该插件（插件根目录已存在）→ 跳过整个插件，避免降级与版本混合。
    // 但若该文件与本地完全一致，则归为 unchanged（保证重复写回幂等）。
    if (merge) {
      const root = pluginRootRel(f.rel);
      if (root) {
        try {
          const localRoot = safeJoin(agentDir, root);
          if (existsSync(localRoot) && lstatSync(localRoot).isDirectory()) {
            if (existsSync(target) && fileEqualsBuffer(target, srcBuf)) unchanged.push({ rel: f.rel, target });
            else skipped.push({ rel: f.rel, target, reason: "merge：本机已装该插件，保留本机版本" });
            continue;
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (existsSync(target)) {
      // 已一致：无需处理
      if (fileEqualsBuffer(target, srcBuf)) {
        unchanged.push({ rel: f.rel, target });
        continue;
      }
      // 安全防护：归档里是脱敏占位符，而本地已有真实值 → 跳过，别把真密钥抹了
      if (!force && hasRedaction(srcBuf)) {
        const local = readFileSync(target);
        if (!hasRedaction(local)) {
          skipped.push({
            rel: f.rel,
            target,
            reason: "本地已有真实值，跳过以免用 __REDACTED__ 覆盖（加 --force 强制）",
          });
          continue;
        }
      }
      // 目标是目录：不覆盖
      try {
        if (lstatSync(target).isDirectory()) {
          failed.push({ rel: f.rel, target, error: "目标是一个目录，拒绝覆盖" });
          continue;
        }
      } catch {
        /* ignore */
      }
    }

    if (dryRun) {
      skipped.push({ rel: f.rel, target, reason: "dry-run" });
      continue;
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      let backup = null;
      if (existsSync(target)) backup = backupExisting(target, "apply");
      writeFileSync(target, srcBuf);
      applied.push({ rel: f.rel, target, backup, merged: mergedSettings || mergedNpm });
      if (mergedSettings) merged.push({ rel: f.rel, target, kind: "settings-packages" });
      if (mergedNpm) merged.push({ rel: f.rel, target, kind: "npm-dependencies" });
      log(
        `  ${backup ? "已覆盖" : "已写入"} ${f.rel} → ${target}` +
          (mergedSettings ? "（已合并 packages，保留本机插件声明）" : "") +
          (mergedNpm ? "（已合并 dependencies，保留本机插件依赖）" : "") +
          (backup ? `（原文件备份为 ${backup}）` : ""),
      );
    } catch (e) {
      failed.push({ rel: f.rel, target, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    ok: failed.length === 0,
    applied,
    unchanged,
    skipped,
    failed,
    merged,
    total: files.length,
  };
}

/** 目标目录里是否已经装好了插件实现（node_modules 是否非空） */
export function hasPluginCode(restoredDir) {
  const roots = [join(restoredDir, "npm", "node_modules"), join(restoredDir, "git")];
  return roots.some((r) => {
    try {
      if (!existsSync(r)) return false;
      if (statSync(r).isFile()) return true;
      return readdirSync(r).length > 0;
    } catch {
      return false;
    }
  });
}
