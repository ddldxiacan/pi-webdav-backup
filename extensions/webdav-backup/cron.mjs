/**
 * cron.mjs — 安装/移除 Windows 计划任务（每日定时备份）
 *
 * 用 schtasks.exe。任务名默认 PiWebDavBackup。
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export const TASK_NAME = "PiWebDavBackup";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "cli.mjs");

function run(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: err ? String(err.message) : null,
      });
    });
  });
}

function findNode() {
  // schtasks 需要绝对路径；优先用当前 node 可执行文件
  return process.execPath;
}

export async function installCron({ time = "03:00", log = () => {} } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, error: "自动安装计划任务目前仅支持 Windows；其他平台请自行用 cron/systemd 调用 cli.mjs backup" };
  }
  if (!existsSync(cliPath)) {
    return { ok: false, error: `找不到 cli.mjs：${cliPath}` };
  }
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    return { ok: false, error: `时间格式应为 HH:MM，收到：${time}` };
  }

  const node = findNode();
  const cmd = `"${node}" "${cliPath}" backup --reason cron`;

  log(`创建计划任务 ${TASK_NAME}（每日 ${time}）…`);
  const create = await run("schtasks.exe", [
    "/Create",
    "/TN",
    TASK_NAME,
    "/TR",
    cmd,
    "/SC",
    "DAILY",
    "/ST",
    time,
    "/F",
  ]);

  if (!create.ok) {
    const msg = `${create.stderr || create.stdout || create.error}`.trim();
    // 常见原因：非管理员权限
    return {
      ok: false,
      error: `创建计划任务失败：${msg}${/拒绝访问|Access is denied/i.test(msg) ? "（请以管理员身份运行）" : ""}`,
    };
  }
  log(`已创建计划任务：${TASK_NAME}`);
  return { ok: true, taskName: TASK_NAME, time, command: cmd };
}

export async function uninstallCron({ log = () => {} } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, error: "仅支持 Windows" };
  }
  log(`删除计划任务 ${TASK_NAME} …`);
  const r = await run("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]);
  if (!r.ok) {
    const msg = `${r.stderr || r.stdout || r.error}`.trim();
    if (/找不到|cannot find|does not exist/i.test(msg)) {
      return { ok: true, taskName: TASK_NAME, removed: false, note: "任务本来就不存在" };
    }
    return { ok: false, error: `删除失败：${msg}` };
  }
  return { ok: true, taskName: TASK_NAME, removed: true };
}
