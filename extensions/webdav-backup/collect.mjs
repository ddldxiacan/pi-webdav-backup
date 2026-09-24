/**
 * collect.mjs — 文件收集与 glob 排除
 */

import { readdirSync, statSync, lstatSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";

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
 * @returns {{files: {abs: string, rel: string, size: number, mtimeMs: number}[], skipped: number, totalSize: number}}
 */
export function collectFiles({ agentDir, scope, exclude, followSymlinks = false }) {
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

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const totalSize = files.reduce((n, f) => n + f.size, 0);
  return { files, skipped, totalSize };
}
