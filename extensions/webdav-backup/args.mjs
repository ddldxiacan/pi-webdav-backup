/**
 * args.mjs — 子命令解析（扩展入口 webdav-backup.ts 与 cli.mjs 共用）
 *
 * 背景：早期写法 `tokens[0] ?? fallback` 在 tokens[0] 为空串时不会兜底
 * （`??` 只认 null/undefined，空串是"有值"），于是 `/backup` 不带参数时
 * `"".trim().split(/\s+/)` 得到 `[""]`，空串被当成命令传给 CLI，
 * 最终报出冒号后为空的「未知命令：」。这里统一做空 token 容错。
 */

/**
 * 从 token 列表里取第一个非空 token（小写）作为子命令；
 * 全是空 token（或列表为空/缺失）时返回 fallback。
 *
 * 保持「第一个参数就是命令」的既有语义：flag（`-` 开头）不当作空 token
 * 跳过，它照样会被当成命令并得到明确的「未知命令：xxx」报错。
 *
 * @param {readonly (string | null | undefined)[] | null | undefined} tokens
 * @param {string} fallback
 * @returns {string}
 */
export function pickCommand(tokens, fallback) {
  for (const t of tokens ?? []) {
    const s = String(t ?? "").trim();
    if (s) return s.toLowerCase();
  }
  return fallback;
}
