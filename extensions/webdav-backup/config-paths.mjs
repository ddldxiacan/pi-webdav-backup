/**
 * config-paths.mjs — 路径解析（独立模块，避免 secrets.mjs 与 config.mjs 循环依赖）
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** 解析 agent 目录（不依赖 pi 包，CLI 子进程也能用） */
export function resolveAgentDir() {
  const envDir = process.env[AGENT_DIR_ENV];
  if (envDir && envDir.trim()) return envDir.trim();
  return join(homedir(), ".pi", "agent");
}

/** getAgentDir 的本地等价实现 */
export function getAgentDir() {
  return resolveAgentDir();
}

export function configPath() {
  return join(getAgentDir(), "webdav-backup.json");
}

export function statePath() {
  return join(getAgentDir(), "webdav-backup-state.json");
}

export function logPath() {
  return join(getAgentDir(), "webdav-backup.log");
}
