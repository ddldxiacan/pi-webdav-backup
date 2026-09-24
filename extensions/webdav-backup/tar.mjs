/**
 * tar.mjs — 极简 ustar tar 读取器（与 backup.mjs 的 TarWriter 配对）
 *
 * 只处理我们自己生成的归档：ustar 格式，文件类型 0（普通文件），
 * 支持 GNU/ustar prefix 长路径。不做符号链接、稀疏文件等。
 */

import { createReadStream } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const BLOCK = 512;

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8").trim();
}

function readOctal(buf, start, len) {
  const s = readString(buf, start, len).replace(/\0/g, "").trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isNaN(n) ? 0 : n;
}

function isZeroBlock(buf) {
  for (const b of buf) if (b !== 0) return false;
  return true;
}

/** 防目录穿越：拒绝绝对路径与 .. */
function safeJoin(destDir, entryName) {
  const normalized = normalize(entryName.replace(/\\/g, "/")).replace(/^([/\\])+/, "");
  const target = join(destDir, normalized);
  const base = normalize(destDir + sep);
  if (!normalize(target + sep).startsWith(base) && normalize(target) !== normalize(destDir)) {
    throw new Error(`归档包含不安全路径，已拒绝：${entryName}`);
  }
  return { target, normalized };
}

/**
 * 流式解包 tar（未压缩）。
 * @param {string} tarFile
 * @param {string} destDir
 * @param {{onEntry?: (name: string, size: number) => void, list?: boolean, overwrite?: boolean}} opts
 */
export async function extractTar(tarFile, destDir, opts = {}) {
  const { onEntry, list = false } = opts;
  const stream = createReadStream(tarFile, { highWaterMark: BLOCK * 32 });
  const entries = [];

  let pending = Buffer.alloc(0);
  const take = async (n) => {
    while (pending.length < n) {
      const chunk = await once(stream);
      if (chunk === null) return null;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    }
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  };

  const iter = stream[Symbol.asyncIterator]();
  const once = async () => {
    const { value, done } = await iter.next();
    return done ? null : value;
  };

  let zeroCount = 0;
  while (true) {
    const header = await take(BLOCK);
    if (header === null) break;
    if (header.length < BLOCK) break;
    if (isZeroBlock(header)) {
      zeroCount++;
      if (zeroCount >= 2) break;
      continue;
    }

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);

    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const body = size > 0 ? await take(padded) : Buffer.alloc(0);
    if (body === null) break;

    if (type !== "0" && type !== "\0" && type !== "") {
      // 目录/其他类型：跳过
      if (type === "5") entries.push({ name: fullName, size: 0, dir: true });
      continue;
    }

    entries.push({ name: fullName, size, dir: false });
    onEntry?.(fullName, size);

    if (!list) {
      const { target, normalized } = safeJoin(destDir, fullName);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body.subarray(0, size));
      void normalized;
    }
  }

  return entries;
}
