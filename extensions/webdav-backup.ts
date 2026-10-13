/**
 * webdav-backup.ts — pi 扩展：把插件/配置/扩展自动备份到 WebDAV
 *
 * 命令：
 *   /backup          立即备份（同步等待，输出实时日志）
 *   /backup check    测试 WebDAV 连通性与认证
 *   /backup list     列出远端已有备份
 *   /backup prune    清理旧备份（保留 keepVersions 个）
 *   /backup dry      试运行：只扫描不传
 *   /backup status   查看上次备份状态
 *   /backup restore  列出可恢复的备份；加 -y 直接恢复到临时目录
 *   /backup apply-extras  把恢复目录里 agentDir 之外的数据（extra/）归位到真实路径
 *   /backup verify   配置体检（密钥来源、明文告警、连接性）
 *   /backup keys     管理密钥：列表 / 设置 / 删除 / 迁移明文
 *
 * 密钥不明文落盘：remote.password 与 encryptKey 支持
 *   dpapi:名称（Windows 用户级加密，推荐）、$ENV_VAR、file:路径、!命令
 *   /backup-setup    交互式向导：生成/修改 ~/.pi/agent/webdav-backup.json
 *   /backup-cron     安装/移除每日定时备份（Windows 计划任务）
 *   /backup-log      查看最近日志
 *
 * 自动行为：
 *   退出 pi（session_shutdown, reason=quit）时，若 backupOnExit 为 true
 *   且距上次自动备份超过 backupOnExitMinIntervalMinutes，则启动一个
 *   【分离的子进程】执行上传 —— 不阻塞 pi 退出，也不怕终端被关。
 *
 * 安装位置：~/.pi/agent/extensions/webdav-backup.ts
 * 首次加载后运行 /reload
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliJson } from "./webdav-backup/json.mjs";
import { pickCommand } from "./webdav-backup/args.mjs";
import { detectLegacyConfig } from "./webdav-backup/extras.mjs";

// bundler/jiti 下 import.meta.url 可能不可用，做兜底
const EXT_DIR = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return join(getAgentDir(), "extensions", "webdav-backup");
  }
})();

const CLI = [
  join(EXT_DIR, "cli.mjs"),
  join(EXT_DIR, "webdav-backup", "cli.mjs"),
].find((p) => existsSync(p)) ?? join(EXT_DIR, "webdav-backup", "cli.mjs");

function configFile() {
  return join(getAgentDir(), "webdav-backup.json");
}
function stateFile() {
  return join(getAgentDir(), "webdav-backup-state.json");
}
function logFile() {
  return join(getAgentDir(), "webdav-backup.log");
}

/** 探测 agentDir 之外的遗留配置（包一层，便于将来加缓存/容错） */
function detectLegacyConfigLocal(): { path: string; kind: string; note: string }[] {
  try {
    return detectLegacyConfig(getAgentDir());
  } catch {
    return [];
  }
}

function readJson<T = unknown>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

type BackupState = { lastBackupAt?: string; lastReason?: string };

function lastAutoBackupMs(): number {
  const s = readJson<BackupState>(stateFile());
  if (!s?.lastBackupAt) return 0;
  const t = Date.parse(s.lastBackupAt);
  return Number.isNaN(t) ? 0 : t;
}

/** 运行 cli.mjs 并把输出实时回显（同步等待） */
function runCli(
  args: string[],
  ctx: ExtensionCommandContext,
  { timeoutMs = 10 * 60 * 1000 }: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        ctx.ui.notify(`备份超时（${Math.round(timeoutMs / 1000)}s），已终止`, "error");
        child.kill();
      }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stdout += text;
      for (const line of text.split("\n")) {
        const t = line.trim();
        // 末行 JSON 汇总是给程序读的，不刷到状态栏
        if (t && !t.startsWith("{")) ctx.ui.setStatus("webdav-backup", line.slice(0, 90));
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${e.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.ui.setStatus("webdav-backup", undefined);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** 分离子进程执行退出备份：不阻塞 pi 退出 */
function spawnDetachedBackup(timeoutMs: number): { ok: boolean; error?: string } {
  try {
    if (!existsSync(CLI)) return { ok: false, error: `找不到 ${CLI}` };
    const child = spawn(process.execPath, [CLI, "backup", "--reason", "exit"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PI_WEBDAV_BACKUP_EXIT_TIMEOUT_MS: String(timeoutMs) },
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function fmtSize(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * 体检并（在用户同意时）补装插件。
 * dir 指向要体检的目录——恢复流程里必须传「刚恢复出来的目录」：
 * 恢复默认解到临时目录，声明还在那里，看当前 agent 目录会永远报“没声明插件”。
 */
async function repairPluginsFlow(
  ctx: ExtensionCommandContext,
  dir: string | null,
  note: string,
): Promise<void> {
  const dirArgs = dir ? ["--dir", dir] : [];
  const pl = await runCli(["plugins", "--json", ...dirArgs], ctx, { timeoutMs: 60_000 });
  const pa = parseCliJson(pl) as { issues?: { source: string }[] } | null;
  if (!pa?.issues?.length) return;
  const names = pa.issues.map((i) => i.source).join("、");
  const fix = await ctx.ui.confirm(
    "插件未安装完整",
    `检测到 ${pa.issues.length} 个已声明但未装好的插件：\n${names}\n\n${note}\n\n现在补装吗？`,
  );
  if (!fix) return;
  ctx.ui.setStatus("webdav-backup", "补装插件中…");
  const rp = await runCli(["repair-plugins", "--json", ...dirArgs], ctx, { timeoutMs: 30 * 60 * 1000 });
  ctx.ui.setStatus("webdav-backup", undefined);
  const pr = parseCliJson(rp) as { repaired?: unknown[]; failed?: unknown[] } | null;
  if (rp.ok) ctx.ui.notify(`插件补装完成（${pr?.repaired?.length ?? 0} 个）`, "info");
  else ctx.ui.notify(`插件补装未全部成功（失败 ${pr?.failed?.length ?? 0} 个）`, "warning");
}

/**
 * 恢复后把恢复目录写回当前 agent 目录（换机一键还原）。
 * 默认【合并模式】：保护本机已装插件（已存在的不被覆盖），settings.json 只合并 packages。
 * 覆盖前自动备份旧文件；归档里是 __REDACTED__ 而本地有真实值时会跳过。
 * 返回是否写回成功，以及备份里是否已含插件实现代码。
 */
async function applyRestoredFlow(
  ctx: ExtensionCommandContext,
  dir: string,
): Promise<{ applied: boolean; pluginReady: boolean }> {
  const dry = await runCli(["restore-apply", "--dir", dir, "--dry-run", "--json"], ctx, { timeoutMs: 120_000 });
  const d = parseCliJson(dry) as {
    total?: number;
    applied?: unknown[];
    unchanged?: unknown[];
    skipped?: { rel: string; target?: string }[];
    failed?: unknown[];
  } | null;
  const total = d?.total ?? 0;
  if (total === 0) return { applied: false, pluginReady: false };

  // 本机已装了插件？让用户选合并（默认，保本机）还是完全替换（旧机原样）
  const curPlugins = countLocalPackages();
  let mode = "merge";
  if (curPlugins > 0) {
    const pick = await ctx.ui.select(
      `写回当前 pi？本机已装 ${curPlugins} 个插件`,
      [
        "合并（推荐）— 保留本机已装插件，只补本机没有的；不删除/不降级本机插件",
        "替换 — 完全还原成备份里的状态（可能删掉/降级本机插件）",
      ],
    );
    if (!pick) return { applied: false, pluginReady: false };
    mode = pick.startsWith("替换") ? "replace" : "merge";
  }

  const modeNote =
    mode === "merge"
      ? "合并模式：本机已装的插件实现（node_modules / git）保留不被覆盖；settings.json 只合并 packages，保留本机已有插件声明。"
      : "替换模式：完全还原成备份里的状态，同名插件会被降级/覆盖，本机多装的插件声明会被移除（不会删插件代码）。";
  const ok = await ctx.ui.confirm(
    `写回当前 pi 配置目录（${mode === "merge" ? "合并" : "替换"}）？`,
    `将把恢复出来的 ${total} 个文件写回：\n${dir}\n→ ${getAgentDir()}\n\n${modeNote}\n` +
      `已存在且内容不同的文件会先备份为 <名字>.bak-apply-<时间戳>；` +
      `归档里是 __REDACTED__ 而本地有真实值的文件会被跳过（避免把真密钥覆盖成占位符）。\n\n继续吗？`,
  );
  if (!ok) return { applied: false, pluginReady: false };

  ctx.ui.setStatus("webdav-backup", "写回配置中…");
  const r = await runCli(["restore-apply", "--dir", dir, "--mode", mode, "--json"], ctx, { timeoutMs: 5 * 60 * 1000 });
  ctx.ui.setStatus("webdav-backup", undefined);
  const res = parseCliJson(r) as {
    applied?: unknown[];
    unchanged?: unknown[];
    skipped?: { rel: string }[];
    failed?: unknown[];
    merged?: unknown[];
    pluginReady?: boolean;
  } | null;
  if (!r.ok) {
    ctx.ui.notify(`写回未全部成功（失败 ${res?.failed?.length ?? 0} 个）`, "warning");
    return { applied: false, pluginReady: false };
  }
  const skippedN = res?.skipped?.length ?? 0;
  ctx.ui.notify(
    `已写回 ${res?.applied?.length ?? 0} 个文件到 ${getAgentDir()}（${mode === "merge" ? "合并" : "替换"}）` +
      (res?.merged?.length ? "\nsettings.json 已合并 packages，保留本机插件声明" : "") +
      (skippedN > 0 ? `\n${skippedN} 个因本机已有版本或本地真实值被跳过` : "") +
      (res?.pluginReady ? "\n插件实现代码已一并恢复，重启 pi 后即可使用。" : ""),
    skippedN > 0 ? "warning" : "info",
  );
  return { applied: true, pluginReady: res?.pluginReady === true };
}

/** 本机 settings.json 里声明了多少个插件（仅用于写回前的提示） */
function countLocalPackages(): number {
  try {
    const s = readJson<{ packages?: unknown[] }>(join(getAgentDir(), "settings.json"));
    return Array.isArray(s?.packages) ? s.packages.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 恢复后把 extra/（agentDir 之外的数据）归位到真实路径。
 * 这些文件默认只解到恢复目录，需用户确认后才写回 ~/.pi/settings.json、~/.config/... 等。
 */
async function applyExtrasFlow(ctx: ExtensionCommandContext, dir: string): Promise<void> {
  const dry = await runCli(["apply-extras", "--dir", dir, "--dry-run", "--json"], ctx, { timeoutMs: 60_000 });
  const d = parseCliJson(dry) as {
    applied?: unknown[];
    skipped?: { rel: string; target?: string }[];
    unparsed?: { rel: string }[];
    unmapped?: { rel: string; orig?: string; target?: string }[];
    failed?: { rel: string; target?: string; error?: string }[];
    source?: { hostname?: string; platform?: string; home?: string } | null;
  } | null;
  const toWrite = (d?.applied?.length ?? 0) + (d?.skipped?.length ?? 0);
  if (toWrite === 0) return;
  const srcNote = d?.source
    ? `来源机器：${d.source.hostname ?? "?"}（${d.source.platform ?? "?"}），home=${d.source.home ?? "?"}\n`
    : "";
  const ok = await ctx.ui.confirm(
    "归位 agentDir 之外的数据？",
    `恢复目录里有 ${toWrite} 个 agentDir 之外的配置文件（如 ~/.pi/settings.json、~/.config/rpiv-*）：\n` +
      srcNote +
      `${(d?.skipped ?? []).slice(0, 5).map((x) => `  ${x.target}`).join("\n")}\n\n` +
      `将写回真实路径（跨机时会按家目录/XDG 锚点重映射；已存在且内容相同的会跳过）。继续吗？`,
  );
  if (!ok) return;
  ctx.ui.setStatus("webdav-backup", "归位额外数据中…");
  // 不加 --force：applyExtraFiles 会跳过“本地已有真实值、而归档里是 __REDACTED__”的文件，
  // 以免把真密钥覆盖成占位符。被跳过的会以告警列出，用户可手动处理。
  const r = await runCli(["apply-extras", "--dir", dir, "--json"], ctx, { timeoutMs: 60_000 });
  ctx.ui.setStatus("webdav-backup", undefined);
  const res = parseCliJson(r) as {
    applied?: unknown[];
    failed?: unknown[];
    skipped?: { rel: string }[];
    unmapped?: { rel: string }[];
  } | null;
  if (r.ok) {
    const skippedN = res?.skipped?.length ?? 0;
    const unmappedN = res?.unmapped?.length ?? 0;
    const extraNote =
      (skippedN > 0 ? `；${skippedN} 个因本地已有真实值被跳过（避免用 __REDACTED__ 覆盖，如需强制用 /backup apply-extras <目录> --force）` : "") +
      (unmappedN > 0 ? `；${unmappedN} 个未匹配家目录/XDG 锚点，按原路径归位，请核对` : "");
    ctx.ui.notify(`已归位 ${res?.applied?.length ?? 0} 个文件${extraNote}`, skippedN > 0 || unmappedN > 0 ? "warning" : "info");
  } else {
    ctx.ui.notify(`归位未全部成功（失败 ${res?.failed?.length ?? 0} 个）`, "warning");
  }
}

export default function webdavBackupExtension(pi: ExtensionAPI) {
  // ---------------------------------------------------------------- 退出自动备份
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") return;

    const cfg = readJson<{
      enabled?: boolean;
      backupOnExit?: boolean;
      backupOnExitMinIntervalMinutes?: number;
      backupOnExitTimeoutMs?: number;
    }>(configFile());

    if (!cfg || cfg.enabled === false || cfg.backupOnExit === false) return;
    const remote = (cfg as { remote?: { url?: string } }).remote;
    if (!remote?.url) return;

    const minInterval = Number(cfg.backupOnExitMinIntervalMinutes ?? 30) * 60_000;
    const since = Date.now() - lastAutoBackupMs();
    if (lastAutoBackupMs() > 0 && minInterval > 0 && since < minInterval) {
      const mins = Math.ceil((minInterval - since) / 60_000);
      ctx.ui.notify(`WebDAV 备份跳过：距上次不足 ${mins} 分钟`, "info");
      return;
    }

    const timeoutMs = Number(cfg.backupOnExitTimeoutMs ?? 10 * 60 * 1000);
    const r = spawnDetachedBackup(timeoutMs);
    if (r.ok) {
      ctx.ui.notify("WebDAV 备份已在后台开始上传，可安全退出", "info");
    } else {
      ctx.ui.notify(`WebDAV 备份启动失败：${r.error}`, "error");
    }
  });

  // ---------------------------------------------------------------- /backup
  pi.registerCommand("backup", {
    description: "WebDAV 备份：备份插件与配置（子命令见 /backup help）",
    getArgumentCompletions: (prefix) => {
      const subs = [
        "run",
        "check",
        "list",
        "prune",
        "dry",
        "status",
        "restore",
        "restore-apply",
        "apply-extras",
        "verify",
        "plugins",
        "repair-plugins",
        "keys",
        "help",
      ];
      const f = subs.filter((s) => s.startsWith(prefix));
      return f.length ? f.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      // 注意：不能写 `split(/\s+/)[0] ?? "run"`——空串会绕过 ?? 兜底（见 args.mjs）
      const sub = pickCommand(args.trim().split(/\s+/), "run");

      if (sub === "help") {
        ctx.ui.notify(
          [
            "/backup          立即备份",
            "/backup check   测试 WebDAV 连接与认证",
            "/backup list    列出远端已有备份",
            "/backup prune   清理旧备份",
            "/backup dry     试运行（只扫描不上传）",
            "/backup status  查看上次备份状态",
            "/backup restore 查看可恢复的备份列表",
            "                （/backup restore -y 恢复到临时目录后询问是否写回当前 pi）",
            "/backup restore-apply <目录> 写回当前 pi（默认合并，保留本机已装插件）",
            "/backup apply-extras 把恢复目录里 agentDir 之外的数据归位到真实路径",
            "/backup verify  配置体检（密钥来源 / 明文告警 / 连接性）",
            "/backup plugins 体检已声明插件是否装齐（含缺失依赖）",
            "/backup repair-plugins 补装缺失的插件 / 依赖",
            "/backup keys    管理密钥（列表 / 设置 / 删除 / 迁移明文）",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (!existsSync(configFile())) {
        const yes = await ctx.ui.confirm(
          "尚未配置 WebDAV",
          `配置文件不存在：\n${configFile()}\n\n现在用向导创建吗？`,
        );
        if (yes) {
          await ctx.ui.notify("请运行 /backup-setup 完成配置", "info");
        }
        return;
      }

      if (sub === "apply-extras") {
        const dir = args.trim().split(/\s+/)[1];
        if (!dir) {
          ctx.ui.notify("用法：/backup apply-extras <恢复目录>", "warning");
          return;
        }
        await applyExtrasFlow(ctx, dir);
        return;
      }

      if (sub === "restore-apply" || sub === "apply-restore") {
        const dir = args.trim().split(/\s+/)[1];
        if (!dir) {
          ctx.ui.notify("用法：/backup restore-apply <恢复目录>（把恢复结果写回当前 agent 目录）", "warning");
          return;
        }
        await applyRestoredFlow(ctx, dir);
        return;
      }

      // ── 体检：报告密钥来源与明文告警
      if (sub === "verify") {
        const r = await runCli(["doctor", "--json"], ctx, { timeoutMs: 60_000 });
        const d = parseCliJson(r) as {
          ok?: boolean;
          url?: string;
          username?: string;
          password?: { source?: string; plaintext?: boolean };
          encryptKey?: { configured?: boolean; source?: string; plaintext?: boolean };
          dpapiAvailable?: boolean;
          connectivity?: { ok?: boolean; error?: string } | null;
          errors?: string[];
          warnings?: string[];
        };
        const rows = [
          `WebDAV: ${d.url || "(未设置)"}`,
          `用户: ${d.username || "(未设置)"}`,
          `密码来源: ${d.password?.source ?? "空"}${d.password?.plaintext ? "  ⚠️ 明文" : ""}`,
          `加密密钥: ${
            d.encryptKey?.configured ? `${d.encryptKey.source}${d.encryptKey.plaintext ? " ⚠️ 明文" : ""}` : "(未配置)"
          }`,
          `DPAPI: ${d.dpapiAvailable ? "可用" : "不可用（非 Windows）"}`,
          `连接: ${d.connectivity ? (d.connectivity.ok ? "通过 ✅" : `失败 — ${d.connectivity.error}`) : "未测"}`,
        ];
        if (d.warnings?.length) rows.push(`告警: ${d.warnings.join("；")}`);
        if (d.errors?.length) rows.push(`错误: ${d.errors.join("；")}`);
        ctx.ui.notify(rows.join("\n"), d.ok ? "info" : "error");
        return;
      }

      // ── 密钥管理
      if (sub === "keys") {
        const action = (args.trim().split(/\s+/)[1] ?? "list").toLowerCase();

        if (action === "list") {
          const r = await runCli(["list-secrets", "--json"], ctx, { timeoutMs: 60_000 });
          const d = parseCliJson(r) as {
            available?: boolean;
            secrets?: { name: string; updatedAt?: string }[];
          };
          const items = d.secrets ?? [];
          ctx.ui.notify(
            items.length === 0
              ? `DPAPI 存储中没有密钥${d.available ? "" : "（DPAPI 不可用：非 Windows）"}`
              : `已保存的密钥：\n${items.map((s) => `  ${s.name}  ${s.updatedAt ?? ""}`).join("\n")}`,
            "info",
          );
          return;
        }

        if (action === "set") {
          const name = args.trim().split(/\s+/)[2];
          if (!name) {
            ctx.ui.notify("用法：/backup keys set <名称>，例如 /backup keys set webdav-password", "warning");
            return;
          }
          const value = await ctx.ui.input(`密钥值（${name}）`, "输入后将以 DPAPI 加密保存");
          if (value === undefined || value === "") return;
          const r = await runCli(["set-secret", "--name", name, "--value", value, "--json"], ctx, {
            timeoutMs: 60_000,
          });
          if (r.ok) {
            ctx.ui.notify(
              `已加密保存「${name}」\n在配置里写 dpapi:${name} 即可引用`,
              "info",
            );
          } else {
            const line = r.stdout.trim().split("\n").pop() ?? "{}";
            let msg = r.stderr.trim() || `退出码 ${r.code}`;
            try {
              msg = (JSON.parse(line) as { error?: string }).error ?? msg;
            } catch {
              /* ignore */
            }
            ctx.ui.notify(`保存失败：${msg}`, "error");
          }
          return;
        }

        if (action === "rm" || action === "delete") {
          const name = args.trim().split(/\s+/)[2];
          if (!name) {
            ctx.ui.notify("用法：/backup keys rm <名称>", "warning");
            return;
          }
          const ok = await ctx.ui.confirm("删除密钥？", `将删除 DPAPI 密钥「${name}」，引用它的配置会失效。`);
          if (!ok) return;
          const r = await runCli(["rm-secret", "--name", name, "--json"], ctx, { timeoutMs: 60_000 });
          ctx.ui.notify(r.ok ? `已删除「${name}」` : `删除失败：${r.stderr.trim()}`, r.ok ? "info" : "error");
          return;
        }

        if (action === "migrate") {
          const raw = readFileSync(configFile(), "utf8");
          const hasPlain =
            /"password"\s*:\s*"(?!dpapi:|file:|plain:|!|\$)[^"]+"/.test(raw) ||
            /"encryptKey"\s*:\s*"(?!dpapi:|file:|plain:|!|\$)[^"]+"/.test(raw);

          if (!hasPlain) {
            ctx.ui.notify("配置里没有明文密钥，无需迁移", "info");
            return;
          }

          const method = await ctx.ui.select("迁移方式", [
            "dpapi  — Windows 用户级加密（推荐，无需主密码）",
            "env    — 写入用户环境变量",
            "file   — 写入 0600 权限的独立文件",
          ]);
          if (!method) return;
          const m = method.split(" ")[0];

          const ok = await ctx.ui.confirm(
            "确认迁移？",
            `将把明文密钥转为 ${m} 引用，并自动备份原配置。`,
          );
          if (!ok) return;

          const r = await runCli(["migrate", "--method", m, "--json"], ctx, { timeoutMs: 120_000 });
          const line = r.stdout.trim().split("\n").pop() ?? "{}";
          let msg = r.ok ? "迁移完成" : "迁移失败";
          try {
            const parsed = JSON.parse(line) as {
              migrated?: number;
              message?: string;
              error?: string;
              changes?: { field: string; to: string }[];
            };
            if (parsed.error) msg = parsed.error;
            else if (parsed.message) msg = parsed.message;
            else if (parsed.changes?.length)
              msg = `已迁移 ${parsed.migrated} 项：\n${parsed.changes.map((c) => `  ${c.field} → ${c.to}`).join("\n")}`;
          } catch {
            /* ignore */
          }
          ctx.ui.notify(msg, r.ok ? "info" : "error");
          return;
        }

        ctx.ui.notify(
          "用法：\n/backup keys list\n/backup keys set <名称>\n/backup keys rm <名称>\n/backup keys migrate",
          "info",
        );
        return;
      }

      const cliArgs: string[] =
        sub === "run" ? ["backup"] : sub === "dry" ? ["backup", "--dry-run"] : [sub];
      if (sub === "check" || sub === "list" || sub === "status") {
        cliArgs.push("--json");
      }

      // restore：先用列表展示，用户确认后才真正下载
      if (sub === "restore") {
        const autoYes = /(^|\s)(-y|--yes)(\s|$)/.test(args);
        const listRun = await runCli(["restore", "--list", "--json"], ctx, { timeoutMs: 60_000 });
        const listing = parseCliJson(listRun) as {
          archives?: { name: string; size: number }[];
          snapshot?: { name: string; fileCount: number } | null;
        };
        const options: string[] = [
          ...(listing.archives ?? []).map((a) => `${a.name} (${fmtSize(a.size)})`),
          ...(listing.snapshot ? [`${listing.snapshot.name} [快照, ${listing.snapshot.fileCount} 个文件]`] : []),
        ];
        if (options.length === 0) {
          ctx.ui.notify("远端没有可恢复的备份", "warning");
          return;
        }

        const picked = autoYes
          ? options[0]
          : await ctx.ui.select("选择要恢复的备份", options);
        if (!picked) return;
        const fileName = picked.split(" (")[0].replace(/\/$/, "");

        const ok = autoYes
          ? true
          : await ctx.ui.confirm(
              "确认恢复？",
              `将从 ${fileName} 恢复文件。\n先解到一个临时目录，之后会询问是否写回当前 pi 配置目录（${getAgentDir()}）。\n写回时覆盖前会自动备份旧文件。`,
            );
        if (!ok) return;

        const restoreArgs = ["restore", "--file", fileName];
        ctx.ui.setStatus("webdav-backup", "恢复中…");
        const rr = await runCli(restoreArgs, ctx, { timeoutMs: 30 * 60 * 1000 });
        ctx.ui.setStatus("webdav-backup", undefined);
        const last = rr.stdout.trim().split("\n").pop() ?? "{}";
        let info: { ok?: boolean; dest?: string; files?: number; error?: string } = {};
        try {
          info = JSON.parse(last) as typeof info;
        } catch {
          /* ignore */
        }
        if (rr.ok && info.ok) {
          ctx.ui.notify(`恢复完成：${info.files} 个文件 → ${info.dest}`, "info");
          const dest = info.dest;
          if (!dest) return;

          // 换机一键还原：把恢复结果写回当前 agent 目录（覆盖前自动备份）
          const applied = await applyRestoredFlow(ctx, dest);

          // agentDir 之外的额外数据（~/.pi/settings.json 等）单独归位
          const extrasInDest = (info as { extras?: unknown[] }).extras?.length ?? 0;
          if (extrasInDest > 0) {
            await applyExtrasFlow(ctx, dest);
          }

          if (applied.applied) {
            // 已写回当前目录：只有备份不含插件代码时才需要联网补装
            if (!applied.pluginReady) {
              await repairPluginsFlow(
                ctx,
                null,
                "备份里不含插件实现代码（node_modules）。这台机器正在用的 agent 目录里，声明的插件没装齐。",
              );
            } else {
              ctx.ui.notify("配置已全部还原。建议 /reload 或重启 pi 让插件生效。", "info");
            }
          } else {
            // 未写回：针对刚恢复出来的目录体检并补装，用户再自行拷贝
            await repairPluginsFlow(
              ctx,
              dest,
              `插件实现代码不在备份里（node_modules 被排除）。补装会装进恢复目录：${dest}\n装完把这些文件拷到 ~/.pi/agent 即可直接使用。`,
            );
          }
        } else {
          ctx.ui.notify(`恢复失败：${info.error || rr.stderr.trim() || `退出码 ${rr.code}`}`, "error");
        }
        return;
      }

      ctx.ui.setStatus("webdav-backup", "备份中…");
      const r = await runCli(cliArgs, ctx, { timeoutMs: 30 * 60 * 1000 });

      // status/list/check 用 JSON 结果做友好展示
      if (sub === "status") {
        const parsed = parseCliJson(r) as { state?: BackupState };
        ctx.ui.notify(
          parsed.state?.lastBackupAt
            ? `上次备份：${new Date(parsed.state.lastBackupAt).toLocaleString()}（${parsed.state.lastReason ?? "?"}）`
            : "还没有备份记录",
          "info",
        );
        return;
      }

      if (sub === "check" || sub === "list") {
        const parsed = parseCliJson(r) as {
          ok?: boolean;
          error?: string;
          status?: number;
          files?: { name: string; size: number }[];
        };
        if (sub === "check") {
          ctx.ui.notify(
            parsed.ok ? "WebDAV 连接正常，认证通过 ✅" : `连接失败：${parsed.error ?? parsed.status}`,
            parsed.ok ? "info" : "error",
          );
        } else {
          const files = parsed.files ?? [];
          ctx.ui.notify(
            files.length === 0
              ? "远端暂无备份文件"
              : `远端 ${files.length} 个文件：\n${files
                  .slice(0, 10)
                  .map((f) => `${f.name}  ${fmtSize(f.size)}`)
                  .join("\n")}${files.length > 10 ? `\n…还有 ${files.length - 10} 个` : ""}`,
            "info",
          );
        }
        return;
      }

      // 备份/试运行/清理：解析最后一行 JSON 汇总
      const line = r.stdout.trim().split("\n").pop() ?? "{}";
      let summary: Record<string, unknown> = {};
      try {
        summary = JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* 非 JSON 输出，忽略 */
      }

      if (r.ok) {
        if (summary.dryRun) {
          ctx.ui.notify(
            `试运行完成：${summary.files} 个文件，${fmtSize(Number(summary.totalSize ?? 0))}，跳过 ${summary.skipped} 项`,
            "info",
          );
        } else if (summary.mode === "snapshot") {
          ctx.ui.notify(
            `备份完成：上传 ${summary.uploaded} 个，跳过 ${summary.skippedSame} 个未变化文件`,
            "info",
          );
        } else if (summary.remotePath) {
          ctx.ui.notify(
            `备份完成 ✅\n${summary.remotePath}\n${summary.files} 个文件，归档 ${fmtSize(Number(summary.archiveSize ?? 0))}`,
            "info",
          );
        } else if (Array.isArray(summary.deleted)) {
          ctx.ui.notify(
            (summary.deleted as string[]).length > 0
              ? `已清理 ${(summary.deleted as string[]).length} 个旧备份`
              : "没有需要清理的旧备份",
            "info",
          );
        } else {
          ctx.ui.notify("完成", "info");
        }
      } else {
        ctx.ui.notify(`失败：${summary.error || r.stderr.trim() || `退出码 ${r.code}`}`, "error");
      }
    },
  });

  // ---------------------------------------------------------------- /backup-setup
  pi.registerCommand("backup-setup", {
    description: "交互式配置 WebDAV 备份",
    handler: async (_args, ctx) => {
      const existing = readJson<Record<string, unknown>>(configFile()) ?? {};
      const cur = (existing.remote ?? {}) as Record<string, string>;

      ctx.ui.notify("WebDAV 备份配置向导（直接回车保留原值）", "info");

      const url = await ctx.ui.input("WebDAV 地址", cur.url ?? "https://dav.jianguoyun.com/dav/");
      if (url === undefined) return;

      const username = await ctx.ui.input("用户名 / 邮箱", cur.username ?? "");
      if (username === undefined) return;

      const password = await ctx.ui.input(
        "密码（坚果云请用【应用密码】）。留空则用环境变量或稍后 /backup keys set",
        "",
      );
      if (password === undefined) return;

      // 密码优先用 DPAPI 加密存储，配置文件里只留引用
      let passwordRef = cur.password ?? "";
      let dpapiNote = "";
      if (password) {
        const safe = await ctx.ui.confirm(
          "用 DPAPI 加密保存密码？",
          "是（推荐）：密码经 Windows 用户级加密存入 secrets.dpapi.json，配置文件里只写 dpapi:webdav-password，无需主密码。\n\n否：密码会以明文写进 webdav-backup.json。",
        );
        if (safe) {
          const sr = await runCli(
            ["set-secret", "--name", "webdav-password", "--value", password, "--json"],
            ctx,
            { timeoutMs: 60_000 },
          );
          if (sr.ok) {
            passwordRef = "dpapi:webdav-password";
            dpapiNote = "密码已用 DPAPI 加密保存";
          } else {
            const line = sr.stdout.trim().split("\n").pop() ?? "{}";
            let msg = sr.stderr.trim();
            try {
              msg = (JSON.parse(line) as { error?: string }).error ?? msg;
            } catch {
              /* ignore */
            }
            const goPlain = await ctx.ui.confirm(
              "DPAPI 保存失败",
              `${msg || "未知错误"}\n\n改为明文写入配置吗？（不推荐）`,
            );
            if (!goPlain) return;
            passwordRef = password;
          }
        } else {
          passwordRef = password;
        }
      }

      const remoteDir = await ctx.ui.input("远端目录", cur.remoteDir ?? "pi-backup");
      if (remoteDir === undefined) return;

      const remoteName = await ctx.ui.input("备份名前缀", cur.remoteName ?? "pi-agent");
      if (remoteName === undefined) return;

      const includePlugins = await ctx.ui.confirm(
        "把插件实现代码一并备份？",
        "是（推荐）：连同 node_modules 一起备份，换机后恢复即可直接用，无需联网重装。\n体积会明显变大（可能几百 MB）。\n\n否：只备份声明，恢复后用 /backup repair-plugins 联网补装。",
      );

      const includeSessions = await ctx.ui.confirm("包含会话历史？", "会显著增大备份体积（可能几百 MB）");
      const encrypt = await ctx.ui.confirm(
        "加密备份？",
        "用 AES-256-GCM 加密，防止 auth.json 里的密钥泄露到云端",
      );

      let encryptKey = (existing.encryptKey as string) ?? "";
      let keyNote = "";
      if (encrypt) {
        const k1 = await ctx.ui.input("设置加密口令（至少 16 位）", "");
        if (k1 === undefined) return;
        if (k1.length < 16) {
          ctx.ui.notify("加密口令至少 16 位，已取消", "error");
          return;
        }
        const k2 = await ctx.ui.input("再输一次确认", "");
        if (k2 !== k1) {
          ctx.ui.notify("两次输入不一致，已取消", "error");
          return;
        }
        encryptKey = k1;

        const safeKey = await ctx.ui.confirm(
          "用 DPAPI 加密保存口令？",
          "是（推荐）：配置里只写 dpapi:backup-key，避免明文落盘。",
        );
        if (safeKey) {
          const sr = await runCli(
            ["set-secret", "--name", "backup-key", "--value", k1, "--json"],
            ctx,
            { timeoutMs: 60_000 },
          );
          if (sr.ok) {
            encryptKey = "dpapi:backup-key";
            keyNote = "加密口令已用 DPAPI 加密保存";
          } else {
            const line = sr.stdout.trim().split("\n").pop() ?? "{}";
            let msg = sr.stderr.trim();
            try {
              msg = (JSON.parse(line) as { error?: string }).error ?? msg;
            } catch {
              /* ignore */
            }
            const goPlainKey = await ctx.ui.confirm(
              "DPAPI 保存失败",
              `${msg || "未知错误"}\n\n改为明文写入配置吗？（不推荐）`,
            );
            if (!goPlainKey) {
              ctx.ui.notify("已取消配置向导（未写入任何更改）", "warning");
              return;
            }
          }
        } else {
          const goPlainKey = await ctx.ui.confirm(
            "口令将以明文保存",
            "加密口令会明文写进 webdav-backup.json。确定继续吗？",
          );
          if (!goPlainKey) return;
        }
      }

      // 保留已有的引用形式，避免向导把 dpapi: 引用覆盖成空
      const finalPassword = password ? passwordRef : (cur.password ?? "");

      // 探测 agentDir 之外、可能影响插件加载的遗留配置（~/.pi/settings.json 等），
      // 让用户决定是否一并纳入 extraScope。
      const existingExtra: string[] = Array.isArray(existing.extraScope)
        ? (existing.extraScope as string[]).filter((x) => typeof x === "string")
        : [];
      let extraScope = existingExtra;
      const legacy = detectLegacyConfigLocal();
      if (legacy.length > 0) {
        const want = await ctx.ui.confirm(
          "发现 agentDir 之外的配置",
          `检测到这些文件不在默认备份范围（~/.pi/agent）内：\n${legacy
            .map((l) => `  ${l.path}`)
            .join("\n")}\n\n是否把它们一并备份（extraScope）？恢复时可用 /backup apply-extras 归位。`,
        );
        if (want) {
          extraScope = [...new Set([...existingExtra, ...legacy.map((l) => l.path)])];
        }
      }

      const cfg = {
        _说明: "pi WebDAV 备份配置，由 /backup-setup 生成",
        enabled: existing.enabled !== false,
        remote: {
          url,
          username,
          password: finalPassword,
          remoteDir,
          remoteName,
        },
        scope: ["."],
        exclude: [],
        extraScope,
        includePlugins,
        includeSessions,
        snapshot: existing.snapshot === true,
        encrypt,
        encryptKey,
        backupOnExit: existing.backupOnExit !== false,
        backupOnExitMinIntervalMinutes: existing.backupOnExitMinIntervalMinutes ?? 30,
        backupOnExitTimeoutMs: 10 * 60 * 1000,
        keepVersions: existing.keepVersions ?? 10,
        timeoutMs: 60_000,
        insecureTls: false,
      };

      try {
        mkdirSync(dirname(configFile()), { recursive: true });
        writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
      } catch (e) {
        ctx.ui.notify(`写入配置失败：${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }

      ctx.ui.notify(
        [`配置已保存：${configFile()}`, dpapiNote, keyNote].filter(Boolean).join("\n") + "\n正在测试连接…",
        "info",
      );
      const r = await runCli(["check", "--json"], ctx, { timeoutMs: 60_000 });
      if (r.ok) {
        ctx.ui.notify("WebDAV 连接正常 ✅ 可以运行 /backup 了", "info");
      } else {
        const line = r.stdout.trim().split("\n").pop() ?? "{}";
        let msg = "连接测试失败";
        try {
          msg = (JSON.parse(line) as { error?: string }).error ?? msg;
        } catch {
          /* ignore */
        }
        ctx.ui.notify(`${msg}\n配置已保存，修正后重试 /backup check`, "error");
      }
    },
  });

  // ---------------------------------------------------------------- /backup-cron
  pi.registerCommand("backup-cron", {
    description: "安装/移除每日定时备份（Windows 计划任务）",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "remove" || sub === "uninstall" || sub === "off") {
        const r = await runCli(["uninstall-cron"], ctx);
        ctx.ui.notify(r.ok ? "已移除计划任务" : `移除失败：${r.stderr.trim()}`, r.ok ? "info" : "error");
        return;
      }

      const time = /^\d{1,2}:\d{2}$/.test(sub) ? sub : "03:00";
      const yes = await ctx.ui.confirm(
        "安装每日定时备份？",
        `将创建 Windows 计划任务，每天 ${time} 执行一次备份。\n需要管理员权限（若失败请以管理员身份运行 pi）。`,
      );
      if (!yes) return;

      const r = await runCli(["install-cron", "--time", time, "--json"], ctx);
      const line = r.stdout.trim().split("\n").pop() ?? "{}";
      let msg = r.ok ? `已创建计划任务，每天 ${time} 备份` : "创建失败";
      try {
        const parsed = JSON.parse(line) as { error?: string };
        if (!r.ok && parsed.error) msg = parsed.error;
      } catch {
        /* ignore */
      }
      ctx.ui.notify(msg, r.ok ? "info" : "error");
    },
  });

  // ---------------------------------------------------------------- /backup-log
  pi.registerCommand("backup-log", {
    description: "查看 WebDAV 备份日志尾部",
    handler: async (_args, ctx) => {
      const f = logFile();
      if (!existsSync(f)) {
        ctx.ui.notify("暂无日志", "info");
        return;
      }
      try {
        const text = readFileSync(f, "utf8");
        const lines = text.trimEnd().split("\n");
        ctx.ui.notify(lines.slice(-20).join("\n"), "info");
      } catch (e) {
        ctx.ui.notify(
          `读取日志失败：${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });
}
