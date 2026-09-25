/**
 * packages.mjs — 恢复后修复「插件装不回来」的问题
 *
 * 背景：备份有意排除 node_modules（体积大、含平台相关二进制、lockfile 足以重建）。
 *   - npm 装的插件：备份里只有 npm/package.json + package-lock.json，没有实现代码
 *   - git 装的插件：备份里有源码，但该包自己的 node_modules 也被排除
 *
 * pi 只在「git 包目录整个不存在」时才会重新克隆并装依赖；目录在、只是
 * node_modules 缺失时，pi 不会补装，插件会静默带病运行。所以恢复后需要这里兜底。
 *
 * 本模块只做两件事：
 *   analyzePlugins(agentDir)  —— 体检：哪些插件缺安装、哪些缺依赖
 *   repairPlugins(agentDir)   —— 按体检结果补装（npm install / git clone）
 *
 * 零依赖，只用 Node 内置模块。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 解析 git 仓库来源（与 pi 的 parseGitUrl / splitRef 语义对齐）：
 *   - ref 从路径部分的第一个 "@" 切开（ref 可含 "/"，如 feature/x）
 *   - 去掉结尾 ".git"（pi 的安装路径也去掉，不一致会装到 pi 找不到的目录）
 *   - 支持 scp 形式 git@host:path、显式协议 URL、git: 简写 host/path
 * 返回 { host, path, ref, url } 或 null。
 */
export function parseGitRepo(raw) {
  let repo = String(raw).trim();
  let ref = null;
  let host = "";
  let path = "";

  const scp = repo.match(/^git@([^:]+):(.+)$/);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo);

  if (scp) {
    const body = scp[2];
    const i = body.indexOf("@");
    if (i > 0) {
      ref = body.slice(i + 1);
      repo = `git@${scp[1]}:${body.slice(0, i)}`;
    }
    host = scp[1];
    path = i > 0 ? body.slice(0, i) : body;
  } else if (isUrl) {
    try {
      const u = new URL(repo);
      const p = u.pathname.replace(/^\/+/, "");
      const i = p.indexOf("@");
      if (i > 0) {
        ref = p.slice(i + 1);
        u.pathname = `/${p.slice(0, i)}`;
        repo = u.toString().replace(/\/$/, "");
        path = p.slice(0, i);
      } else {
        path = p;
      }
      host = u.hostname;
    } catch {
      return null;
    }
  } else {
    // git: 简写 host/path[@ref]
    const slash = repo.indexOf("/");
    if (slash <= 0) return null;
    host = repo.slice(0, slash);
    const rest = repo.slice(slash + 1);
    const i = rest.indexOf("@");
    if (i > 0) {
      ref = rest.slice(i + 1);
      path = rest.slice(0, i);
    } else {
      path = rest;
    }
    repo = `https://${host}/${path}`;
  }

  // pi 的 buildGitSource：去掉结尾 .git，路径至少两段（user/project）
  path = String(path).replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  if (!host || path.split("/").filter(Boolean).length < 2) return null;
  return { host, path, ref: ref || null, url: repo };
}

/**
 * 解析 settings.json 里的一条 package 声明。
 * 支持字符串形式与 { source, enabled } 对象形式。
 */
export function parsePackageSource(source) {
  const s = typeof source === "string" ? source.trim() : String(source?.source ?? "").trim();
  if (!s) return null;

  if (s.startsWith("npm:")) {
    const spec = s.slice(4).trim();
    // 兼容 @scope/name@version 与 name@version
    const at = spec.lastIndexOf("@");
    const hasVersion = at > 0;
    return {
      type: "npm",
      source: s,
      name: hasVersion ? spec.slice(0, at) : spec,
      version: hasVersion ? spec.slice(at + 1) : null,
    };
  }

  if (s.startsWith("git:")) {
    const parsed = parseGitRepo(s.slice(4).trim());
    if (parsed) return { type: "git", source: s, ...parsed };
    return { type: "local", source: s, path: s };
  }

  // 显式协议 URL / scp 形式：与 pi 一致，都算 git 来源
  if (/^(https?|ssh|git):\/\//i.test(s) || /^git@[^:]+:.+$/.test(s)) {
    const parsed = parseGitRepo(s);
    if (parsed) return { type: "git", source: s, ...parsed };
  }

  // 本地路径：不做安装，仅记录
  return { type: "local", source: s, path: s };
}

/** 读取 settings.json 里声明的包（忽略 enabled:false 的） */
export function readDeclaredPackages(agentDir) {
  const file = join(agentDir, "settings.json");
  if (!existsSync(file)) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  const list = Array.isArray(raw?.packages) ? raw.packages : [];
  const out = [];
  for (const entry of list) {
    if (entry && typeof entry === "object" && entry.enabled === false) continue;
    const parsed = parsePackageSource(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** 该包在 agent 目录里的安装位置（pi 的约定） */
export function installPathFor(agentDir, pkg) {
  if (pkg.type === "npm") return join(agentDir, "npm", "node_modules", ...pkg.name.split("/"));
  if (pkg.type === "git") return join(agentDir, "git", pkg.host, ...pkg.path.split("/"));
  if (pkg.type === "local") return pkg.path;
  return null;
}

/** 读包目录里的 package.json，返回 { deps, optional }（依赖名列表）；无法读取返回 null */
function readDeps(pkgDir) {
  const file = join(pkgDir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return {
      deps: Object.keys(pkg.dependencies ?? {}),
      optional: Object.keys(pkg.optionalDependencies ?? {}),
    };
  } catch {
    return null;
  }
}

/**
 * 缺依赖检测：逐个依赖名查 node_modules（同 pi 的 hasMissingGitDependencies），
 * 只看 dependencies。只判断 node_modules 目录存在会漏掉「拷了一半」的情况。
 * 返回缺失的依赖名数组；无法判断时返回 null。
 */
function missingDeps(pkgDir, depNames) {
  if (!depNames) return null;
  return depNames.filter((name) => !existsSync(join(pkgDir, "node_modules", ...String(name).split("/"))));
}

/**
 * 体检：恢复后哪些插件需要补装。
 * @returns {{ok: boolean, packages: Array, issues: Array}}
 */
export function analyzePlugins(agentDir) {
  const declared = readDeclaredPackages(agentDir);
  const packages = [];
  const issues = [];

  for (const pkg of declared) {
    if (pkg.type === "local") {
      packages.push({ source: pkg.source, type: "local", status: "skip", detail: "本地路径，不参与安装" });
      continue;
    }

    const dir = installPathFor(agentDir, pkg);
    if (!existsSync(dir)) {
      const detail = pkg.type === "npm" ? `缺少安装：${dir}` : `缺少克隆：${dir}`;
      packages.push({ source: pkg.source, type: pkg.type, status: "missing-install", detail, path: dir });
      issues.push({ source: pkg.source, type: pkg.type, kind: "missing-install", detail, path: dir });
      continue;
    }

    // 目录在：检查依赖是否齐（git 包尤其常见——源码恢复了，node_modules 没恢复）
    const deps = readDeps(dir);
    const missing = missingDeps(dir, deps?.deps ?? null);
    if (missing && missing.length > 0) {
      const detail = `缺少依赖：${missing.slice(0, 3).join("、")}${missing.length > 3 ? ` 等 ${missing.length} 个` : ""}`;
      packages.push({ source: pkg.source, type: pkg.type, status: "missing-deps", detail, path: dir });
      issues.push({ source: pkg.source, type: pkg.type, kind: "missing-deps", detail, path: dir });
      continue;
    }

    packages.push({ source: pkg.source, type: pkg.type, status: "ok", detail: "已安装", path: dir });
  }

  return { ok: issues.length === 0, packages, issues };
}

/**
 * Windows 下 spawnSync(..., shell: true) 会把参数原样拼进 cmd /c，
 * 含空格的路径（用户名带空格等）会被拆开，必须自己加引号。
 */
function quoteArg(a) {
  const s = String(a);
  return /[\s"^&|<>()%!]/.test(s) ? `"${s.replace(/"/g, '\"')}"` : s;
}

/** 默认执行器：返回 {ok, error}，不抛异常。带超时，避免网络卡死时挂住 UI */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function defaultRun(command, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const useShell = process.platform === "win32";
  const res = spawnSync(command, useShell ? args.map(quoteArg) : args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    encoding: "utf8",
    shell: useShell,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (res.error) {
    const isTimeout = res.error.code === "ETIMEDOUT" || /timed? ?out/i.test(res.error.message);
    return {
      ok: false,
      error: isTimeout ? `执行超时（${Math.round(timeoutMs / 1000)}s）：${command} ${args.join(" ")}` : res.error.message,
    };
  }
  if (res.status !== 0) {
    const tail = String(res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" ");
    return { ok: false, error: `${command} 退出码 ${res.status}${tail ? `：${tail}` : ""}` };
  }
  return { ok: true };
}

/** 确保 npm 工作目录存在（与 pi 一致：package.json + .gitignore） */
function ensureNpmProject(npmDir) {
  mkdirSync(npmDir, { recursive: true });
  const ignore = join(npmDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n!.gitignore\n", "utf8");
  const pkgJson = join(npmDir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: "pi-extensions", private: true }, null, 2), "utf8");
  }
}

/**
 * 按体检结果补装插件。
 * @param {string} agentDir
 * @param {{log?: Function, dryRun?: boolean, run?: Function, timeoutMs?: number}} opts
 * @returns {{ok: boolean, repaired: Array, failed: Array, skipped: Array}}
 */
export function repairPlugins(agentDir, opts = {}) {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.run ?? ((c, a, dir) => defaultRun(c, a, dir, timeoutMs));
  const analysis = analyzePlugins(agentDir);

  const repaired = [];
  const failed = [];
  const skipped = [];

  for (const issue of analysis.issues) {
    const pkg = parsePackageSource(issue.source);
    if (!pkg) {
      skipped.push({ source: issue.source, reason: "无法解析" });
      continue;
    }

    if (pkg.type === "npm") {
      const npmDir = join(agentDir, "npm");
      const spec = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
      log(`补装 npm 插件 ${spec} …`);
      if (dryRun) {
        skipped.push({ source: issue.source, reason: `dry-run：将执行 npm install ${spec}（在 ${npmDir}）` });
        continue;
      }
      if (!existsSync(npmDir)) ensureNpmProject(npmDir);
      // --legacy-peer-deps 与 pi 一致：不要自动装宿主提供的 @earendil-works/pi-* peer，
      // 否则装出来的陈旧 peer 会挡住 pi 的更新
      const r = run("npm", ["install", spec, "--legacy-peer-deps", "--no-fund", "--no-audit"], npmDir);
      if (r.ok) repaired.push({ source: issue.source, action: `npm install ${spec}` });
      else failed.push({ source: issue.source, error: r.error });
      continue;
    }

    if (pkg.type === "git") {
      const dir = installPathFor(agentDir, pkg);
      const needsClone = issue.kind === "missing-install";

      if (needsClone) {
        // 先走快路径：浅克隆 + --branch（分支 / 标签）。
        // commit SHA 之类的 ref --branch 认不了，失败时回退成 pi 的做法：完整 clone + checkout。
        const shallowArgs = ["clone", "--depth", "1"];
        if (pkg.ref) shallowArgs.push("--branch", pkg.ref);
        shallowArgs.push(pkg.url, dir);
        log(`克隆 git 插件 ${pkg.url}${pkg.ref ? `@${pkg.ref}` : ""} …`);
        if (dryRun) {
          skipped.push({ source: issue.source, reason: `dry-run：将执行 git ${shallowArgs.join(" ")}` });
          continue;
        }
        let r = run("git", shallowArgs, agentDir);
        if (!r.ok && pkg.ref) {
          log(`浅克隆失败（ref=${pkg.ref} 可能不是分支/标签），回退为完整克隆 + checkout …`);
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          r = run("git", ["clone", pkg.url, dir], agentDir);
          if (r.ok) r = run("git", ["checkout", pkg.ref], dir);
        }
        if (!r.ok) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          failed.push({ source: issue.source, error: r.error });
          continue;
        }
      }

      // 克隆完 / 目录已在，都检查依赖（逐个依赖名查 node_modules，同 pi）
      const deps = readDeps(dir);
      const missing = missingDeps(dir, deps?.deps ?? null);
      if (missing && missing.length > 0) {
        log(`安装 ${pkg.path} 的依赖（${missing.length} 个缺失）…`);
        if (dryRun) {
          skipped.push({ source: issue.source, reason: `dry-run：将执行 npm install（在 ${dir}）` });
          continue;
        }
        // --omit=dev 与 pi 一致：只装运行时依赖
        const r = run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], dir);
        if (!r.ok) {
          failed.push({ source: issue.source, error: r.error });
          continue;
        }
      }

      repaired.push({
        source: issue.source,
        action: needsClone ? `git clone${pkg.ref ? ` (${pkg.ref})` : ""}` : "npm install",
      });
      continue;
    }

    skipped.push({ source: issue.source, reason: "不支持的来源类型" });
  }

  return {
    ok: failed.length === 0,
    repaired,
    failed,
    skipped,
    before: analysis,
  };
}
