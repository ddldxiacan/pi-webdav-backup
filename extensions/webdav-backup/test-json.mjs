#!/usr/bin/env node
/**
 * test-json.mjs — CLI 输出 JSON 解析的容错性
 *
 * 回归背景：空输出曾抛 "Unexpected end of JSON input"，
 * 在 pi 里显示为 Extension "command:backup" error，真实错误被吞掉。
 */
import { parseCliJson } from "./json.mjs";

let pass = 0;
let fail = 0;
const check = (n, c, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`);
  }
};

console.log("pi WebDAV 备份 — CLI JSON 解析容错测试\n");

// 正常：取最后一个非空行解析
const r1 = parseCliJson({ stdout: '日志行\n{"ok":true,"files":3}\n', stderr: "", code: 0 });
check("取最后一个非空行解析", r1 && r1.ok === true && r1.files === 3);

const r2 = parseCliJson({ stdout: '{"a":{"b":1}}' });
check("单行 JSON 也正常", r2 && r2.a && r2.a.b === 1);

// 回归：空输出 + stderr → 抛出含真实原因的错误
let thrown = null;
try {
  parseCliJson({ stdout: "", stderr: "Cannot find module cli.mjs", code: 1 });
} catch (e) {
  thrown = e;
}
check(
  "空输出抛出含 stderr 的错误（回归）",
  thrown !== null &&
    /Cannot find module/.test(thrown.message) &&
    !/Unexpected end of JSON/.test(thrown.message),
  thrown?.message,
);

thrown = null;
try {
  parseCliJson({ stdout: "\n  \n", stderr: "boom", code: 2 });
} catch (e) {
  thrown = e;
}
check("纯空白输出同样容错", thrown !== null && /boom/.test(thrown.message), thrown?.message);

thrown = null;
try {
  parseCliJson({ stdout: "", stderr: "", code: 7 });
} catch (e) {
  thrown = e;
}
check("无输出无 stderr 时提示退出码", thrown !== null && /退出码 7/.test(thrown.message), thrown?.message);

// 非 JSON 文本 → 友好错误，不抛裸 JSON 语法错
thrown = null;
try {
  parseCliJson({ stdout: "连接失败：401", stderr: "", code: 1 });
} catch (e) {
  thrown = e;
}
check(
  "非 JSON 输出不抛裸语法错误",
  thrown !== null &&
    !/Unexpected end of JSON/.test(thrown.message) &&
    /连接失败/.test(thrown.message),
  thrown?.message,
);

// 边界
thrown = null;
try {
  parseCliJson(null);
} catch (e) {
  thrown = e;
}
check("null 输入不崩溃", thrown !== null);

check("JSON 标量也可返回", parseCliJson({ stdout: "42" }) === 42);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
