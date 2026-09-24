#!/usr/bin/env node
/**
 * cli.mjs — 备份引擎命令行入口
 *
 * 用法：
 *   node cli.mjs backup [--reason manual|exit] [--dry-run] [--json]
 *   node cli.mjs check  [--json]          测试 WebDAV 连通性与认证
 *   node cli.mjs list   [--json]          列出远端已有备份
 *   node cli.mjs prune  [--keep N]        清理旧备份
 *   node cli.mjs restore [--file 名称] [--to 目录] [--list] [--json]   恢复备份
 *   node cli.mjs set-secret --name webdav-password [--value X]  用 DPAPI 加密保存密钥
 *   node cli.mjs list-secrets [--json]      列出已存的 DPAPI 密钥（不含明文）
 *   node cli.mjs rm-secret --name X         删除 DPAPI 密钥
 *   node cli.mjs migrate [--method dpapi|env|file] [--dry-run]  把配置明文密钥迁成引用
 *   node cli.mjs auth-scan [--json]         扫描 auth.json 里的明文 API 密钥
 *   node cli.mjs auth-migrate [--method env|dpapi] [--dry-run]  迁移 auth.json 密钥
 *   node cli.mjs doctor [--json]            体检：配置、密钥来源、连接性
 *   node cli.mjs install-cron [--time HH:MM]   安装 Windows 计划任务（每日备份）
 *   node cli.mjs uninstall-cron           移除计划任务
 *
 * 输出人类可读文本或 JSON（--json），退出码 0 成功 / 1 失败。
 *   --value 优先，其次读 stdin（避免密钥出现在进程列表里）
 */

import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configPath, statePath, logPath, resolveAgentDir } from "./config.mjs";
import { runBackup, pruneOldArchives, readState } from "./backup.mjs";
import { WebDAVClient } from "./webdav.mjs";
import {
  setDpapiSecret,
  listDpapiSecrets,
  deleteDpapiSecret,
  dpapiAvailable,
  resolveSecret,
  isPlaintextSecret,
} from "./secrets.mjs";
import { pickCommand } from "./args.mjs";

const args = process.argv.slice(2);
// 注意：不能写 `args[0] ?? "backup"`——空串会绕过 ?? 兜底（见 args.mjs）
const cmd = pickCommand(args, "backup");
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const asJson = has("--json");

function logTo(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  try {
    appendFileSync(logPath(), text, "utf8");
  } catch {
    /* ignore */
  }
  if (!asJson) process.stdout.write(`${line}\n`);
}

function finish(payload, code) {
  if (asJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code ?? (payload.ok ? 0 : 1));
}

/** 从 --value 或 stdin 读取密钥，避免出现在命令行历史/进程列表中 */
async function readSecretInput() {
  const v = val("--value", null);
  if (v !== null) return v;
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main() {
  const agentDir = resolveAgentDir();

  // ── 密钥管理命令（不需要已加载配置）
  if (cmd === "set-secret") {
    const name = val("--name", null);
    if (!name) {
      return finish({ ok: false, error: "缺少 --name" }, 1);
    }
    if (!dpapiAvailable()) {
      return finish({ ok: false, error: "DPAPI 仅支持 Windows；其他平台请用 --method file 或环境变量" }, 1);
    }
    const value = await readSecretInput();
    if (value === null || value === "") {
      return finish(
        { ok: false, error: "缺少密钥值：用 --value 传入，或通过 stdin 输入（推荐）" },
        1,
      );
    }
    try {
      setDpapiSecret(name, value);
      logTo(`已用 DPAPI 加密保存密钥「${name}」`);
      return finish({ ok: true, name, store: "dpapi" }, 0);
    } catch (e) {
      return finish({ ok: false, error: e instanceof Error ? e.message : String(e) }, 1);
    }
  }

  if (cmd === "list-secrets") {
    const items = listDpapiSecrets();
    if (!asJson) {
      if (items.length === 0) logTo("没有已保存的 DPAPI 密钥。");
      else for (const s of items) logTo(`  ${s.name}  ${s.updatedAt ?? ""}  [${s.scope}]`);
    }
    return finish({ ok: true, secrets: items, available: dpapiAvailable() }, 0);
  }

  if (cmd === "rm-secret") {
    const name = val("--name", null);
    if (!name) return finish({ ok: false, error: "缺少 --name" }, 1);
    const removed = deleteDpapiSecret(name);
    logTo(removed ? `已删除密钥「${name}」` : `未找到密钥「${name}」`);
    return finish({ ok: removed, name, removed }, removed ? 0 : 1);
  }

  if (cmd === "migrate") {
    const { migrateSecrets } = await import("./migrate.mjs");
    const method = String(val("--method", "dpapi"));
    const r = await migrateSecrets({ method, log: logTo, dryRun: has("--dry-run") });
    if (!r.ok) logTo(`迁移失败：${r.error}`);
    return finish(r, r.ok ? 0 : 1);
  }

  // ── auth.json 明文 API 密钥迁移
  if (cmd === "auth-scan") {
    const { scanAuthSecrets } = await import("./auth-migrate.mjs");
    const scan = scanAuthSecrets();
    if (!asJson) {
      if (!scan.ok) logTo(`扫描失败：${scan.error}`);
      else if (scan.items.length === 0) logTo("auth.json 没有条目。");
      else {
        logTo(`auth.json: ${scan.path}`);
        for (const it of scan.items) {
          if (it.kind === "plaintext")
            logTo(`  ⚠️  ${it.provider}: 明文密钥 (${it.keyLength} 字符) → 建议 $${it.suggestedEnv}`);
          else if (it.kind === "reference") logTo(`  ✅ ${it.provider}: ${it.current}`);
          else logTo(`  ·  ${it.provider}: ${it.reason}`);
        }
      }
    }
    return finish({ ok: scan.ok, ...scan }, scan.ok ? 0 : 1);
  }

  if (cmd === "auth-migrate") {
    const { migrateAuthJson } = await import("./auth-migrate.mjs");
    const method = String(val("--method", "env"));
    const r = await migrateAuthJson({ method, log: logTo, dryRun: has("--dry-run") });
    if (!r.ok && r.error) logTo(`迁移失败：${r.error}`);
    else if (r.message) logTo(r.message);
    if (r.warnings?.length) for (const w of r.warnings) logTo(`警告：${w}`);
    return finish(r, r.ok ? 0 : 1);
  }

  const loaded = loadConfig();

  if (!loaded.ok) {
    const err = loaded.errors.join("; ");
    logTo(`配置错误：${err}`);
    finish({ ok: false, error: err, errors: loaded.errors, configPath: configPath() }, 1);
    return;
  }
  const { config, warnings } = loaded;
  for (const w of warnings) logTo(`警告：${w}`);

  if (cmd === "doctor") {
    const report = {
      ok: loaded.ok,
      configPath: configPath(),
      url: config.url,
      username: config.username || "(未设置)",
      password: {
        source: loaded.secrets?.passwordSource ?? "empty",
        plaintext: isPlaintextSecret(loaded.raw?.remote?.password),
      },
      encryptKey: {
        configured: !!config.encryptKey,
        source: loaded.secrets?.encryptKeySource ?? "empty",
        plaintext: isPlaintextSecret(loaded.raw?.encryptKey),
      },
      errors: loaded.errors,
      warnings: loaded.warnings,
      dpapiAvailable: dpapiAvailable(),
      connectivity: null,
    };

    if (loaded.ok && config.url) {
      try {
        const c = new WebDAVClient({
          baseUrl: config.url,
          username: config.username,
          password: config.password,
          timeoutMs: config.timeoutMs,
          insecureTls: config.insecureTls,
        });
        const r = await c.check();
        report.connectivity = { ok: r.ok, status: r.status, error: r.error };
      } catch (e) {
        report.connectivity = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (!asJson) {
      logTo("配置体检");
      logTo(`  配置文件      ${report.configPath}`);
      logTo(`  WebDAV        ${report.url || "(未设置)"}`);
      logTo(`  用户名        ${report.username}`);
      logTo(
        `  密码来源      ${report.password.source}${report.password.plaintext ? "  ⚠️ 明文" : ""}`,
      );
      logTo(
        `  加密密钥      ${report.encryptKey.configured ? report.encryptKey.source : "(未配置)"}${
          report.encryptKey.plaintext ? "  ⚠️ 明文" : ""
        }`,
      );
      logTo(`  DPAPI 可用    ${report.dpapiAvailable ? "是" : "否（非 Windows）"}`);
      logTo(
        `  连接测试      ${
          report.connectivity
            ? report.connectivity.ok
              ? "通过 ✅"
              : `失败：${report.connectivity.error}`
            : "未执行"
        }`,
      );
      if (report.errors.length) logTo(`  错误：${report.errors.join("；")}`);
      if (report.warnings.length) logTo(`  告警：${report.warnings.join("；")}`);
    }
    return finish(report, report.ok ? 0 : 1);
  }

  if (cmd === "check") {
    logTo(`检查 ${config.url} …`);
    const client = new WebDAVClient({
      baseUrl: config.url,
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs,
      insecureTls: config.insecureTls,
    });
    const r = await client.check();
    if (r.ok) {
      logTo("WebDAV 连接正常，认证通过。");
      finish({ ok: true, status: r.status, url: config.url });
    } else {
      logTo(`连接失败：${r.error}`);
      finish({ ok: false, error: r.error, status: r.status }, 1);
    }
    return;
  }

  if (cmd === "list") {
    const client = new WebDAVClient({
      baseUrl: config.url,
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs,
      insecureTls: config.insecureTls,
    });
    const entries = await client.list(config.remoteDir);
    const files = entries.filter((e) => !e.isCollection);
    if (!asJson) {
      if (files.length === 0) logTo(`远端 ${config.remoteDir}/ 暂无备份文件。`);
      else {
        logTo(`远端 ${config.remoteDir}/ 共 ${files.length} 个文件：`);
        for (const f of files) {
          logTo(`  ${f.name}  ${(f.size / 1024).toFixed(1)} KB  ${f.lastModified ?? ""}`);
        }
      }
    }
    finish({ ok: true, files });
    return;
  }

  if (cmd === "prune") {
    const keep = Number(val("--keep", config.keepVersions));
    const r = await pruneOldArchives(config, keep, logTo);
    finish({ ok: true, ...r });
    return;
  }

  if (cmd === "restore") {
    const { restoreBackup } = await import("./restore.mjs");
    const r = await restoreBackup(config, {
      agentDir,
      file: val("--file", null),
      to: val("--to", null),
      listOnly: has("--list"),
      log: logTo,
    });
    finish(r, r.ok ? 0 : 1);
    return;
  }

  if (cmd === "status") {
    const state = readState(statePath());
    finish({ ok: true, state, configPath: configPath() });
    return;
  }

  if (cmd === "install-cron" || cmd === "uninstall-cron") {
    const { installCron, uninstallCron } = await import("./cron.mjs");
    if (cmd === "install-cron") {
      const r = await installCron({ time: val("--time", "03:00"), log: logTo });
      finish({ ok: r.ok, ...r });
    } else {
      const r = await uninstallCron({ log: logTo });
      finish({ ok: r.ok, ...r });
    }
    return;
  }

  if (cmd === "backup" || cmd === "run") {
    const reason = val("--reason", "manual");
    if (!config.enabled && reason === "exit") {
      logTo("自动备份已禁用（enabled: false），跳过。");
      finish({ ok: true, skipped: true, reason: "disabled" });
      return;
    }
    logTo(`开始备份（触发方式：${reason}${has("--dry-run") ? "，试运行" : ""}）`);
    const result = await runBackup(config, {
      log: logTo,
      agentDir,
      stateFile: statePath(),
      dryRun: has("--dry-run"),
      reason,
    });

    if (result.ok && !result.dryRun && reason !== "exit") {
      try {
        await pruneOldArchives(config, config.keepVersions, logTo);
      } catch (e) {
        logTo(`清理旧版本失败（不影响本次备份）：${e.message}`);
      }
    }

    if (!result.ok) logTo(`备份失败：${result.error}`);
    finish(result, result.ok ? 0 : 1);
    return;
  }

  logTo(`未知命令：${cmd}`);
  finish({ ok: false, error: `未知命令：${cmd}` }, 1);
}

main().catch((e) => {
  logTo(`未捕获错误：${e?.stack ?? e?.message ?? String(e)}`);
  finish({ ok: false, error: String(e?.message ?? e) }, 1);
});
