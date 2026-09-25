#!/usr/bin/env node
/**
 * test-plugins.mjs — 恢复后插件补装测试
 *
 * 验证：
 *   1. 解析 settings.json 里的 npm / git / local 声明（含 @scope、@ref）
 *   2. 体检：缺安装（missing-install）、缺依赖（missing-deps）、正常（ok）
 *   3. npm 插件补装走 `npm install <spec>`（带版本号）
 *   4. git 插件目录缺失 → clone；目录在但缺依赖 → 只装依赖
 *   5. 依赖声明为空的 git 包不应被误判为缺依赖
 *   6. 真实恢复到临时目录后，analyzePlugins 能发现插件未装齐
 *   7. 修复不因单个包失败而中止；dry-run 不落盘
 *
 * 安装命令全部通过注入的 run 桩函数模拟（不联网、确定性）；
 * 仅第 6 项跑真实的备份/恢复往返。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDavServer } from "./dav-mock.mjs";
import { loadConfig } from "./config.mjs";
import { runBackup } from "./backup.mjs";
import { restoreBackup } from "./restore.mjs";
import { parsePackageSource, readDeclaredPackages, analyzePlugins, repairPlugins } from "./packages.mjs";

let pass = 0;
let fail = 0;
const lines = [];
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    lines.push(`  ✅ ${n}`);
  } else {
    fail++;
    lines.push(`  ❌ ${n}${d ? ` — ${d}` : ""}`);
  }
};

/** 记录调用的 run 桩 */
function makeRunStub({ failOn = [] } = {}) {
  const calls = [];
  const run = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const key = `${command} ${args.join(" ")}`;
    const hit = failOn.find((f) => key.includes(f));
    if (hit) return { ok: false, error: `模拟失败：${hit}` };
    // 模拟安装产物，便于后续断言
    if (command === "npm") {
      const nodeModules = join(cwd, "node_modules");
      mkdirSync(nodeModules, { recursive: true });
      writeFileSync(join(nodeModules, ".stub"), "1");
      // `npm install <name>[@ver]` 会落地 node_modules/<name>，体检才能转 ok
      const spec = args[1];
      if (spec && spec !== "install") {
        const at = spec.lastIndexOf("@");
        const name = at > 0 ? spec.slice(0, at) : spec;
        const pkgDir = join(nodeModules, ...name.split("/"));
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name }));
      }
    }
    if (command === "git" && args[0] === "clone") {
      const dest = args[args.length - 1];
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "stub" }));
    }
    return { ok: true };
  };
  return { run, calls };
}

async function main() {
  console.log("pi WebDAV 备份 — 插件补装测试\n");

  // ── 1. 来源解析
  check("解析 npm 无版本", JSON.stringify(parsePackageSource("npm:pi-footer")) ===
    JSON.stringify({ type: "npm", source: "npm:pi-footer", name: "pi-footer", version: null }));
  const npmVer = parsePackageSource("npm:pi-footer@1.2.3");
  check("解析 npm 带版本", npmVer.name === "pi-footer" && npmVer.version === "1.2.3", JSON.stringify(npmVer));
  const scoped = parsePackageSource("npm:@scope/pi-tools@2.0.0");
  check("解析 @scope 包", scoped.name === "@scope/pi-tools" && scoped.version === "2.0.0", JSON.stringify(scoped));
  const scopedNoVer = parsePackageSource("npm:@scope/pi-tools");
  check("解析 @scope 无版本", scopedNoVer.name === "@scope/pi-tools" && scopedNoVer.version === null, JSON.stringify(scopedNoVer));
  const git = parsePackageSource("git:github.com/ddldxiacan/pi-webdav-backup@v1.0.2");
  check(
    "解析 git 带 ref",
    git.type === "git" && git.host === "github.com" && git.path === "ddldxiacan/pi-webdav-backup" &&
      git.ref === "v1.0.2" && git.url === "https://github.com/ddldxiacan/pi-webdav-backup",
    JSON.stringify(git),
  );
  const gitPlain = parsePackageSource("git:github.com/example/pi-tools");
  check("解析 git 无 ref", gitPlain.ref === null, JSON.stringify(gitPlain));
  check("解析 local", parsePackageSource("./pi-tools").type === "local");
  check("空声明返回 null", parsePackageSource("") === null && parsePackageSource(null) === null);

  // ── 2. settings.json 读取：跳过 enabled:false
  const dir = mkdtempSync(join(tmpdir(), "pi-plugins-test-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      packages: [
        "npm:pi-footer",
        { source: "npm:pi-disabled", enabled: false },
        "git:github.com/example/pi-tools@v1",
      ],
    }),
  );
  const declared = readDeclaredPackages(dir);
  check("读取声明跳过 enabled:false", declared.length === 2, JSON.stringify(declared.map((d) => d.source)));
  // 坏 JSON 不应抛异常
  writeFileSync(join(dir, "settings.json"), "{ not json");
  check("settings.json 损坏时安全返回空", readDeclaredPackages(dir).length === 0);

  // ── 3. 体检：三类状态
  const d2 = mkdtempSync(join(tmpdir(), "pi-plugins-test2-"));
  writeFileSync(
    join(d2, "settings.json"),
    JSON.stringify({
      packages: [
        "npm:missing-npm",
        "npm:present-npm",
        "git:github.com/example/missing-git",
        "git:github.com/example/nodeps-git",
        "git:github.com/example/deps-git",
        "./local-pkg",
      ],
    }),
  );
  // present-npm：已装
  mkdirSync(join(d2, "npm", "node_modules", "present-npm"), { recursive: true });
  // nodeps-git：目录在、无 dependencies → 正常
  mkdirSync(join(d2, "git", "github.com", "example", "nodeps-git"), { recursive: true });
  writeFileSync(join(d2, "git", "github.com", "example", "nodeps-git", "package.json"), JSON.stringify({ name: "n" }));
  // deps-git：目录在、有 dependencies、缺 node_modules → missing-deps
  const depsGit = join(d2, "git", "github.com", "example", "deps-git");
  mkdirSync(depsGit, { recursive: true });
  writeFileSync(join(depsGit, "package.json"), JSON.stringify({ name: "d", dependencies: { a: "^1", b: "^1" } }));

  const a = analyzePlugins(d2);
  const bySource = Object.fromEntries(a.packages.map((p) => [p.source, p.status]));
  check("npm 缺失 → missing-install", bySource["npm:missing-npm"] === "missing-install", JSON.stringify(bySource));
  check("npm 已装 → ok", bySource["npm:present-npm"] === "ok", JSON.stringify(bySource));
  check("git 目录缺失 → missing-install", bySource["git:github.com/example/missing-git"] === "missing-install", JSON.stringify(bySource));
  check("git 无依赖 → ok（不误报）", bySource["git:github.com/example/nodeps-git"] === "ok", JSON.stringify(bySource));
  check("git 有依赖但缺 node_modules → missing-deps", bySource["git:github.com/example/deps-git"] === "missing-deps", JSON.stringify(bySource));
  check("local → skip", bySource["./local-pkg"] === "skip", JSON.stringify(bySource));
  check("体检 ok=false（有 issue）", a.ok === false);
  check("issue 数为 3", a.issues.length === 3, JSON.stringify(a.issues.map((i) => i.kind)));

  // ── 4. 补装 npm：应执行 npm install <spec>（含版本）
  const d3 = mkdtempSync(join(tmpdir(), "pi-plugins-test3-"));
  writeFileSync(join(d3, "settings.json"), JSON.stringify({ packages: ["npm:pi-footer@1.2.3"] }));
  {
    const { run, calls } = makeRunStub();
    const r = repairPlugins(d3, { run });
    check("npm 补装成功", r.ok === true && r.repaired.length === 1, JSON.stringify(r));
    const install = calls.find((c) => c.command === "npm");
    check("npm 命令带版本号", install && install.args.join(" ") === "install pi-footer@1.2.3 --no-fund --no-audit", JSON.stringify(install));
    check("npm 在 agentDir/npm 下执行", install && install.cwd === join(d3, "npm"), install?.cwd);
    check("复检已通过", analyzePlugins(d3).ok === true);
  }

  // ── 5. git：目录缺失 → clone；目录在缺依赖 → 只 npm install
  const d4 = mkdtempSync(join(tmpdir(), "pi-plugins-test4-"));
  writeFileSync(
    join(d4, "settings.json"),
    JSON.stringify({ packages: ["git:github.com/example/missing-git@v1", "git:github.com/example/deps-git"] }),
  );
  const depsGit4 = join(d4, "git", "github.com", "example", "deps-git");
  mkdirSync(depsGit4, { recursive: true });
  writeFileSync(join(depsGit4, "package.json"), JSON.stringify({ name: "d", dependencies: { a: "^1" } }));
  {
    const { run, calls } = makeRunStub();
    const r = repairPlugins(d4, { run });
    const clone = calls.find((c) => c.command === "git");
    check("git 缺失 → 执行 clone", !!clone && clone.args[0] === "clone", JSON.stringify(calls));
    check("clone 带 --depth 1", clone && clone.args.includes("--depth") && clone.args.includes("1"), JSON.stringify(clone));
    check("clone 带 ref（--branch）", clone && clone.args.includes("--branch") && clone.args.includes("v1"), JSON.stringify(clone));
    check("clone 用 https url", clone && clone.args.some((x) => String(x).startsWith("https://github.com/example/missing-git")), JSON.stringify(clone));
    // deps-git：应在其目录内跑 npm install
    const npmInGit = calls.find((c) => c.command === "npm" && c.cwd === depsGit4);
    check("git 缺依赖 → 在包目录内 npm install", !!npmInGit, JSON.stringify(calls.map((c) => ({ c: c.command, cwd: c.cwd }))));
    check("两个 git 包都算已修复", r.repaired.length === 2, JSON.stringify(r));
  }

  // ── 6. 单个包失败不影响其余；dry-run 不落盘
  const d5 = mkdtempSync(join(tmpdir(), "pi-plugins-test5-"));
  writeFileSync(join(d5, "settings.json"), JSON.stringify({ packages: ["npm:bad-pkg", "npm:good-pkg"] }));
  {
    const { run, calls } = makeRunStub({ failOn: ["bad-pkg"] });
    const r = repairPlugins(d5, { run });
    check("一个失败返回 ok=false", r.ok === false);
    check("失败被记录", r.failed.length === 1 && r.failed[0].source === "npm:bad-pkg", JSON.stringify(r.failed));
    check("失败不影响后续包", r.repaired.some((x) => x.source === "npm:good-pkg"), JSON.stringify(r.repaired));
    check("两个包都尝试了", calls.filter((c) => c.command === "npm").length === 2, JSON.stringify(calls));
  }
  {
    const d6 = mkdtempSync(join(tmpdir(), "pi-plugins-test6-"));
    writeFileSync(join(d6, "settings.json"), JSON.stringify({ packages: ["npm:pi-footer"] }));
    const { run, calls } = makeRunStub();
    const r = repairPlugins(d6, { run, dryRun: true });
    check("dry-run 不执行命令", calls.length === 0, JSON.stringify(calls));
    check("dry-run 列入 skipped", r.skipped.length === 1, JSON.stringify(r.skipped));
    check("dry-run 后仍未安装", analyzePlugins(d6).ok === false);
  }
  // 无需修复时：不执行任何命令
  {
    const d7 = mkdtempSync(join(tmpdir(), "pi-plugins-test7-"));
    writeFileSync(join(d7, "settings.json"), JSON.stringify({ packages: [] }));
    const { run, calls } = makeRunStub();
    const r = repairPlugins(d7, { run });
    check("无声明时不执行命令", calls.length === 0 && r.ok === true);
  }

  // ── 7. 真实往返：备份 → 恢复 → 体检发现插件未装齐
  //     备份有意排除 node_modules，所以恢复出来的插件必然"缺安装"，
  //     这正是需要 repairPlugins 兜底的场景。
  {
    const dav = await startDavServer();
    dav.dirs.add("/dav");
    const agentDir = mkdtempSync(join(tmpdir(), "pi-plugins-e2e-"));
    mkdirSync(join(agentDir, "npm"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-footer@1.2.3"], theme: "dark" }),
    );
    writeFileSync(
      join(agentDir, "npm", "package.json"),
      JSON.stringify({ name: "pi-extensions", private: true, dependencies: { "pi-footer": "^1.2.3" } }),
    );
    // 假装已安装（备份会排除 node_modules）
    mkdirSync(join(agentDir, "npm", "node_modules", "pi-footer"), { recursive: true });
    writeFileSync(join(agentDir, "npm", "node_modules", "pi-footer", "index.js"), "// plugin\n");
    writeFileSync(
      join(agentDir, "webdav-backup.json"),
      JSON.stringify({
        remote: {
          url: `http://127.0.0.1:${dav.port}/dav`,
          username: "user",
          password: "pass",
          remoteDir: "bk",
          remoteName: "pi",
        },
        encrypt: false,
        includeSessions: false,
      }),
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    const config = loadConfig().config;
    const bk = await runBackup(config, { log: () => {}, agentDir, stateFile: join(agentDir, "state.json") });
    check("插件场景备份成功", bk.ok === true, bk.error);

    const dest = join(agentDir, "restored");
    const r = await restoreBackup(config, { agentDir, to: dest, log: () => {} });
    check("插件场景恢复成功", r.ok === true, JSON.stringify(r));
    check("恢复出 settings.json", existsSync(join(dest, "settings.json")));
    check("恢复出 npm 声明文件", existsSync(join(dest, "npm", "package.json")));
    check("恢复不含 node_modules（有意排除）", !existsSync(join(dest, "npm", "node_modules")));

    const analysis = analyzePlugins(dest);
    check("体检发现插件缺安装", analysis.ok === false && analysis.issues.length === 1, JSON.stringify(analysis.issues));
    check(
      "缺安装指向 npm:pi-footer@1.2.3",
      analysis.issues[0]?.source === "npm:pi-footer@1.2.3",
      JSON.stringify(analysis.issues[0]),
    );

    // 补装（注入桩，避免联网）
    const { run, calls } = makeRunStub();
    const repaired = repairPlugins(dest, { run });
    check("恢复后补装成功", repaired.ok === true && repaired.repaired.length === 1, JSON.stringify(repaired));
    check("补装命令正确", calls[0]?.args.join(" ") === "install pi-footer@1.2.3 --no-fund --no-audit", JSON.stringify(calls[0]));
    check("补装后体检通过", analyzePlugins(dest).ok === true);

    dav.server.close();
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  for (const d of [dir, d2, d3, d4, d5]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(lines.join("\n"));
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(lines.join("\n"));
  console.error(`\n测试异常：${e?.stack ?? e}`);
  process.exit(1);
});
