/**
 * collect.mjs — 文件收集与 glob 排除
 */

import { readdirSync, statSync, lstatSync } from "node:fs";
import { join, relative, sep, posix, resolve } from "node:path";

/**
 * 把 agentDir 之外的绝对路径映射成归档内安全、无歧义的相对路径。
 *   C:\Users\me\.pi\settings.json → extra/C/Users/me/.pi/settings.json
 *   /home/me/.pi/settings.json    → extra/home/me/.pi/settings.json
 */
export function extraArchivePath(absPath) {
  let p = resolve(String(absPath)).replace(/\\/g, "/");
  p = p.replace(/^([A-Za-z]):\//, "$1/"); // 去掉盘符后的冒号，保留盘符作为首段
  const segs = p.split("/").filter((s) => s && s !== "." && s !== "..");
  return `extra/${segs.join("/")}`;
}

/**
 * 该额外路径是否是“配置/数据类”文件（值得一并脱敏保护）。
 * 目录一律视为需要保护（其下内容逐文件判断）。
 */
export function isDataLikeExtraPath(absPath) {
  const b = String(absPath).replace(/\\/g, "/").split("/").pop() ?? "";
  const lower = b.toLowerCase();
  return (
    lower.endsWith(".json") ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /\.(ya?ml|toml|ini|conf|cfg|txt)$/i.test(lower) ||
    ["config", "config.json", "settings", "auth", "secret", "secrets", "credentials"].includes(lower)
  );
}

/**
 * 从 extraScope 推导出归档内“需要脱敏”的路径集合。
 * 目录 → "extra/.../dir/"（前缀匹配）；数据类文件 → "extra/.../file"（精确匹配）。
 */
export function deriveSensitivePaths(extraScope) {
  const out = [];
  for (const p of extraScope ?? []) {
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push(`${extraArchivePath(p)}/`);
      else if (st.isFile() && isDataLikeExtraPath(p)) out.push(extraArchivePath(p));
    } catch {
      /* 不存在就跳过（反正不会被收集） */
    }
  }
  return out;
}


/** glob -> RegExp（支持 **、*、?） */
export function globToRegExp(glob) {
  let re = "";
  const g = String(glob).replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // ** 跨目录
        const after = g[i + 2];
        if (after === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function makeExcluder(patterns) {
  const regs = (patterns ?? []).filter((p) => p && String(p).trim()).map((p) => globToRegExp(p));
  return (relPath) => {
    const p = posix.normalize(String(relPath).replace(/\\/g, "/"));
    // 检查路径本身及其任意父目录是否命中
    const segs = p.split("/");
    const candidates = new Set([p]);
    for (let i = 1; i < segs.length; i++) candidates.add(`${segs.slice(0, i).join("/")}/`);
    for (const r of regs) {
      for (const c of candidates) if (r.test(c)) return true;
    }
    return false;
  };
}

/**
 * 收集文件。
 * @param {object} opts
 * @param {string} opts.agentDir  基准目录
 * @param {string[]} opts.scope   相对 agentDir 的路径列表
 * @param {string[]} opts.exclude glob 排除规则
 * @param {string[]} [opts.extraScope] agentDir 之外的绝对路径（文件或目录）
 * @returns {{files: {abs: string, rel: string, size: number, mtimeMs: number}[], skipped: number, totalSize: number}}
 */
export function collectFiles({ agentDir, scope, exclude, extraScope = [], followSymlinks = false }) {
  const isExcluded = makeExcluder(exclude);
  const files = [];
  let skipped = 0;

  const walk = (abs, relDir) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const absPath = join(abs, ent.name);
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;

      if (isExcluded(relPath)) {
        skipped++;
        continue;
      }

      let st;
      try {
        st = followSymlinks ? statSync(absPath) : lstatSync(absPath);
      } catch {
        continue;
      }

      if (st.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (st.isDirectory()) {
        walk(absPath, relPath);
      } else if (st.isFile()) {
        files.push({ abs: absPath, rel: relPath, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      } else {
        skipped++;
      }
    }
  };

  for (const s of scope) {
    const clean = String(s).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const absBase = clean === "." || clean === "" ? agentDir : join(agentDir, clean);
    let st;
    try {
      st = lstatSync(absBase);
    } catch {
      skipped++;
      continue;
    }
    if (st.isDirectory()) walk(absBase, clean === "." || clean === "" ? "" : clean);
    else if (st.isFile()) {
      const rel = relative(agentDir, absBase).split(sep).join("/");
      if (!isExcluded(rel)) files.push({ abs: absBase, rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    }
  }

  // agentDir 之外的额外路径（~/.pi/settings.json、~/.config/rpiv-* 等）
  for (const extra of extraScope) {
    let st;
    try {
      st = lstatSync(extra);
    } catch {
      skipped++;
      continue;
    }
    const baseRel = extraArchivePath(extra);
    if (st.isDirectory()) {
      walkExtra(extra, baseRel);
    } else if (st.isFile()) {
      if (!isExcluded(baseRel)) {
        files.push({ abs: extra, rel: baseRel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
    } else {
      skipped++;
    }
  }

  function walkExtra(abs, relPath) {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const absPath = join(abs, ent.name);
      const rel = `${relPath}/${ent.name}`;
      if (isExcluded(rel)) {
        skipped++;
        continue;
      }
      let st2;
      try {
        st2 = followSymlinks ? statSync(absPath) : lstatSync(absPath);
      } catch {
        continue;
      }
      if (st2.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (st2.isDirectory()) walkExtra(absPath, rel);
      else if (st2.isFile()) {
        files.push({ abs: absPath, rel, size: st2.size, mtimeMs: Math.floor(st2.mtimeMs) });
      } else {
        skipped++;
      }
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const totalSize = files.reduce((n, f) => n + f.size, 0);
  return { files, skipped, totalSize };
}
