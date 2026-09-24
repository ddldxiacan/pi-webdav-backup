/**
 * crypto.mjs — AES-256-GCM 加密（scrypt 派生密钥）
 *
 * 文件格式（*.pibak）：
 *   magic  "PIBAK1\n"            7 字节
 *   salt   16 字节
 *   iv     12 字节
 *   hdrLen 4 字节 (BE)
 *   header JSON（明文，含文件名/大小/校验）
 *   ciphertext
 *   tag    16 字节
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const MAGIC = Buffer.from("PIBAK1\n", "utf8");
const CHUNK = 1024 * 1024;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** 流式加密 srcFile -> dstFile，返回明文 sha256 与密文大小 */
export async function encryptFile(srcFile, dstFile, passphrase, meta = {}) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const header = Buffer.from(
    JSON.stringify({ v: 1, alg: "aes-256-gcm", createdAt: new Date().toISOString(), ...meta }),
    "utf8",
  );
  const hdrLen = Buffer.alloc(4);
  hdrLen.writeUInt32BE(header.length, 0);

  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const hash = createHash("sha256");
  const out = createWriteStream(dstFile);

  out.write(MAGIC);
  out.write(salt);
  out.write(iv);
  out.write(hdrLen);
  out.write(header);

  const source = createReadStream(srcFile, { highWaterMark: CHUNK });
  source.on("data", (c) => hash.update(c));

  await pipeline(
    source,
    new Transform({
      transform(chunk, _enc, cb) {
        cb(null, cipher.update(chunk));
      },
      flush(cb) {
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        cb();
      },
    }),
    out,
  );

  return { sha256: hash.digest("hex"), header: JSON.parse(header.toString("utf8")) };
}

/** 流式解密 .pibak -> dstFile */
export async function decryptFile(srcFile, dstFile, passphrase) {
  const fh = await open(srcFile, "r");
  let pos = 0;
  const readExact = async (n) => {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, pos);
    if (bytesRead !== n) throw new Error("文件损坏：读取头部失败");
    pos += n;
    return buf;
  };

  try {
    const magic = await readExact(7);
    if (!magic.equals(MAGIC)) throw new Error("不是有效的 .pibak 加密文件（magic 不匹配）");

    const salt = await readExact(16);
    const iv = await readExact(12);
    const hdrLen = (await readExact(4)).readUInt32BE(0);
    if (hdrLen <= 0 || hdrLen > 64 * 1024) throw new Error("文件损坏：头部长度异常");
    const header = JSON.parse((await readExact(hdrLen)).toString("utf8"));

    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });

    // 剩余流 = ciphertext + 末尾 16 字节 tag
    const src = createReadStream(null, { fd: fh.fd, start: pos, autoClose: true });
    let tail = Buffer.alloc(0);
    const out = createWriteStream(dstFile);

    await pipeline(
      src,
      new Transform({
        transform(chunk, _enc, cb) {
          const buf = Buffer.concat([tail, chunk]);
          if (buf.length <= 16) {
            tail = buf;
            cb();
            return;
          }
          tail = buf.subarray(buf.length - 16);
          cb(null, decipher.update(buf.subarray(0, buf.length - 16)));
        },
        flush(cb) {
          if (tail.length !== 16) return cb(new Error("文件损坏：认证标签缺失"));
          decipher.setAuthTag(tail);
          try {
            this.push(decipher.final());
            cb();
          } catch (e) {
            cb(new Error(`解密失败（密码错误或文件损坏）：${e.message}`));
          }
        },
      }),
      out,
    );

    return { header };
  } finally {
    await fh.close().catch(() => {});
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export { MAGIC };

/** 校验两个密码是否一致（常量时间），用于 /backup-setup 输入确认 */
export function samePassphrase(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
