/**
 * json.mjs — 安全解析子进程 CLI 输出的 JSON
 *
 * 背景：早期实现直接 JSON.parse(输出最后一行)，CLI 一旦 spawn 失败
 * 或输出为空，就抛裸的 "Unexpected end of JSON input"，
 * 把真正有用的错误（stderr）吞掉。这里做统一容错。
 */

/**
 * 解析 CLI 输出中最后一个非空行的 JSON。
 * 解析失败时抛出带【真实原因】的错误（stderr 优先），
 * 绝不抛裸的 JSON 语法错误。
 *
 * @param {{stdout?: string, stderr?: string, code?: number|null}} result
 * @returns {any} 解析成功的 JSON 值
 */
export function parseCliJson(result) {
  const { stdout = "", stderr = "", code = null } = result ?? {};
  const line = String(stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (line) {
    try {
      return JSON.parse(line);
    } catch {
      /* 继续走下面的友好错误 */
    }
  }
  const hint = String(stderr).trim() || String(stdout).trim();
  throw new Error(hint || `命令失败（退出码 ${code}）`);
}
