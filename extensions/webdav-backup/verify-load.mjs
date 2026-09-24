/**
 * 校验 webdav-backup.ts 能否被 pi 的加载器（jiti）正常导入，
 * 并检查默认导出与命令注册是否符合 pi 的扩展契约。
 *
 * pi-coding-agent 安装目录自动探测；也可用环境变量 PI_PKG_PATH 显式指定。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolvePiRoot() {
  const candidates = [
    process.env.PI_PKG_PATH,
    join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
    join(homedir(), ".pi", "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
  ].filter(Boolean);
  const hit = candidates.find((c) => existsSync(join(c, "dist", "index.js")));
  if (!hit) {
    console.error("找不到 pi-coding-agent 安装，请设置环境变量 PI_PKG_PATH 指向其安装目录");
    process.exit(1);
  }
  return hit;
}

const PI_ROOT = resolvePiRoot();
const PI_PKG = join(PI_ROOT, "dist", "index.js");

let createJiti;
try {
  ({ createJiti } = await import(
    pathToFileURL(join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")).href
  ));
} catch {
  ({ createJiti } = await import("jiti"));
}

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": PI_PKG },
});

const registered = { commands: [], events: [], tools: [] };
const fakePi = {
  on: (evt) => registered.events.push(evt),
  registerCommand: (name) => registered.commands.push(name),
  registerTool: (t) => registered.tools.push(t?.name ?? "?"),
  registerShortcut: () => {},
  registerFlag: () => {},
  sendMessage: () => {},
  appendEntry: () => {},
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
};

const mod = await jiti.import("../webdav-backup.ts");
const factory = mod.default ?? mod;
if (typeof factory !== "function") {
  console.error("❌ 默认导出不是函数：", typeof factory);
  process.exit(1);
}
await factory(fakePi);

const expectCmds = ["backup", "backup-setup", "backup-cron", "backup-log"];
const missingCmds = expectCmds.filter((c) => !registered.commands.includes(c));
console.log("注册的命令：", registered.commands.join(", "));
console.log("订阅的事件：", registered.events.join(", "));
console.log("缺失命令：", missingCmds.length ? missingCmds.join(", ") : "（无）");

// 引擎模块可加载
const cliSrc = readFileSync(new URL("./cli.mjs", import.meta.url), "utf8");
const cliOk = cliSrc.length > 0;
console.log("cli.mjs 存在且非空：", cliOk);

// CLI 路径不变量：入口按「同目录 → webdav-backup 子目录」探测 cli.mjs，
// 布局破坏会静默导致 /backup 系列命令失效，这里做回归防护
const cliProbeHit = existsSync(fileURLToPath(new URL("../webdav-backup/cli.mjs", import.meta.url)));
console.log("入口探测路径 extensions/webdav-backup/cli.mjs 存在：", cliProbeHit);

const ok =
  missingCmds.length === 0 &&
  registered.events.includes("session_shutdown") &&
  registered.commands.length === expectCmds.length &&
  cliOk &&
  cliProbeHit;
console.log(ok ? "\n✅ 扩展契约校验通过" : "\n❌ 扩展契约校验失败");
process.exit(ok ? 0 : 1);
