/**
 * run-tests.mjs — 依次运行所有测试文件并汇总
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => /^test.*\.mjs$/.test(f) && f !== "run-tests.mjs")
  .sort();

let failed = 0;
const summary = [];

for (const f of files) {
  const started = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, f)], { cwd: here, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (out += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, out }));
  });
  const ms = Date.now() - started;
  const failLines = res.out.split("\n").filter((l) => l.includes("❌"));
  const resultLine = res.out.split("\n").filter((l) => /^结果：/.test(l)).pop() ?? "";
  if (res.code !== 0) failed++;
  summary.push(
    `${res.code === 0 ? "✅" : "❌"} ${f.padEnd(20)} ${resultLine || "(no summary)"}  ${(ms / 1000).toFixed(1)}s`,
  );
  if (failLines.length) summary.push(...failLines.map((l) => `      ${l.trim()}`));
  if (res.code !== 0 && !resultLine) {
    summary.push("      " + res.out.split("\n").slice(0, 12).join("\n      "));
  }
}

console.log(summary.join("\n"));
console.log(`\n${files.length} 个测试文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);
