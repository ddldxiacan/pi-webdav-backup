/**
 * restore.mjs — 从 WebDAV 恢复备份
 *
 * 支持两种远端布局：
 *   - 归档：<remoteDir>/<remoteName>-<时间戳>.tar.gz[.pibak]
 *         → 下载、解压（必要时先解密）、解包 tar 到目标目录
 *   - 快照：<remoteDir>/<remoteName>/ 逐文件下载
 *
 * 安全：解包时拒绝绝对路径与 .. 穿越；默认恢复到临时目录而非直接覆盖 ~/.pi/agent。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  createReadStream,
  createWriteStream as createWriteStreamImpl,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import { WebDAVClient } from "./webdav.mjs";
import { archiveNameRe } from "./backup.mjs";
import { decryptFile } from "./crypto.mjs";
import { extractTar } from "./tar.mjs";

/** 列出远端可恢复的备份（归档 + 快照目录） */
export async function listBackups(config) {
  const client = new WebDAVClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    timeoutMs: config.timeoutMs,
    insecureTls: config.insecureTls,
  });
  const entries = await client.list(config.remoteDir);
  const isArchive = archiveNameRe(config.remoteName);
  const archives = entries
    .filter((e) => !e.isCollection && isArchive.test(e.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1))
    .map((e) => ({ type: "archive", name: e.name, size: e.size, lastModified: e.lastModified }));

  const snapDir = `${config.remoteDir}/${config.remoteName}`;
  let snapshot = null;
  try {
    const m = await client.get(`${snapDir}/manifest.json`);
    if (m) {
      const manifest = JSON.parse(m.toString("utf8"));
      snapshot = {
        type: "snapshot",
        name: `${config.remoteName}/`,
        remoteDir: snapDir,
        fileCount: manifest.fileCount ?? manifest.files?.length ?? 0,
        createdAt: manifest.createdAt ?? manifest.updatedAt,
      };
    }
  } catch {
    /* 无快照 */
  }

  return { archives, snapshot, all: snapshot ? [...archives, snapshot] : archives };
}

/**
 * 恢复。
 * @param {object} config
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.file  指定归档名；null 则恢复最新
 * @param {string|null} opts.to    目标目录；null 则解到临时目录
 * @param {boolean} opts.listOnly  只列出不下载
 * @param {(s: string) => void} opts.log
 */
export async function restoreBackup(config, opts) {
  const log = opts.log ?? (() => {});
  const client = new WebDAVClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    timeoutMs: config.timeoutMs,
    insecureTls: config.insecureTls,
  });

  const listing = await listBackups(config);
  if (opts.listOnly) {
    return { ok: true, listOnly: true, ...listing };
  }

  if (listing.all.length === 0) {
    return { ok: false, error: `远端 ${config.remoteDir}/ 下找不到可恢复的备份` };
  }

  // 选择目标
  let target = null;
  if (opts.file) {
    target = listing.archives.find((a) => a.name === opts.file) ?? null;
    if (!target && opts.file.replace(/\/$/, "") === config.remoteName) target = listing.snapshot;
    if (!target) {
      return {
        ok: false,
        error: `找不到指定的备份：${opts.file}`,
        available: listing.all.map((x) => x.name),
      };
    }
  } else {
    target = listing.archives[0] ?? listing.snapshot;
  }

  const workDir = mkdtempSync(join(tmpdir(), "pi-restore-"));
  const destDir = opts.to ?? join(workDir, "restored");
  mkdirSync(destDir, { recursive: true });

  try {
    if (target.type === "snapshot") {
      return await restoreSnapshot({ client, config, target, destDir, log, workDir });
    }
    return await restoreArchive({ client, config, target, destDir, log, workDir });
  } finally {
    // 只在未指定目标目录时保留临时目录（用户需要去那里取文件）
    if (!opts.to) {
      log(`（临时文件保留在 ${workDir}，确认后可自行删除）`);
    } else {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function restoreArchive({ client, config, target, destDir, log, workDir }) {
  const remotePath = `${config.remoteDir}/${target.name}`;
  log(`下载 ${target.name} …`);
  const blob = await client.get(remotePath);
  if (!blob) return { ok: false, error: `下载失败：${remotePath} 不存在` };

  const downloaded = join(workDir, target.name);
  writeFileSync(downloaded, blob);
  log(`已下载 ${(blob.length / 1024 / 1024).toFixed(2)} MB`);

  let tarball = downloaded;
  let header = null;
  if (target.name.endsWith(".pibak")) {
    if (!config.encryptKey) {
      return {
        ok: false,
        error: "该备份是加密的，但配置里没有 encryptKey（或环境变量 PI_WEBDAV_BACKUP_KEY）",
      };
    }
    log("解密中…");
    const decFile = join(workDir, "payload.tar.gz");
    const res = await decryptFile(downloaded, decFile, String(config.encryptKey));
    header = res.header;
    tarball = decFile;
    if (header?.name && header.name !== target.name) {
      log(`注意：归档头部记录的文件名是 ${header.name}`);
    }
  }

  log("解压中…");
  const rawTar = join(workDir, "payload.tar");
  await pipeline(createReadStream(tarball), createGunzip({ chunkSize: 1024 * 1024 }), createWriteStreamImpl(rawTar));

  log("解包中…");
  const entries = await extractTar(rawTar, destDir);
  const fileCount = entries.filter((e) => !e.dir).length;
  log(`恢复完成：${fileCount} 个文件 → ${destDir}`);

  return {
    ok: true,
    mode: "archive",
    source: target.name,
    dest: destDir,
    files: fileCount,
    encrypted: target.name.endsWith(".pibak"),
    header,
  };
}

async function restoreSnapshot({ client, config, target, destDir, log, workDir }) {
  const manifestRaw = await client.get(`${target.remoteDir}/manifest.json`);
  if (!manifestRaw) return { ok: false, error: "快照缺少 manifest.json" };
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  const files = manifest.files ?? [];

  log(`快照包含 ${files.length} 个文件，开始下载…`);
  let done = 0;
  const failed = [];

  for (const f of files) {
    const buf = await client.get(`${target.remoteDir}/${f.rel}`);
    if (!buf) {
      failed.push(f.rel);
      continue;
    }
    // 防穿越
    const parts = String(f.rel).split("/").filter((s) => s && s !== "." && s !== "..");
    const outPath = join(destDir, ...parts);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    done++;
    if (done % 20 === 0) log(`  已恢复 ${done}/${files.length}`);
  }

  log(`恢复完成：${done} 个文件 → ${destDir}${failed.length ? `（${failed.length} 个失败）` : ""}`);
  return {
    ok: failed.length === 0,
    mode: "snapshot",
    source: target.name,
    dest: destDir,
    files: done,
    failed,
  };
}
