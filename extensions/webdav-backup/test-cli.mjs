#!/usr/bin/env node
/**
 * test-cli.mjs — CLI 子进程集成测试
 *
 * 与 test.mjs 互补：这里通过 spawn 真实调用 cli.mjs，
 * 验证扩展实际使用的代码路径（含退出备份那套参数）。
 *
 * 用法：node test-cli.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { startDavServer } from "./dav-mock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.mjs");

let pass = 0;
let fail = 0;
const lines = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    lines.push(`  ✅ ${name}`);
  } else {
    fail++;
    lines.push(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const lastJson = (out) => {
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  try {
    return JSON.parse(line ?? "{}");
  } catch {
    return {};
  }
};

async function main() {
  console.log("pi WebDAV 备份 — CLI 集成测试\n");

  const dav = await startDavServer();
  const baseUrl = `http://127.0.0.1:${dav.port}/dav`;
  dav.dirs.add("/dav");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-cli-test-"));
  mkdirSync(join(agentDir, "extensions", "sub"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "a.ts"), "export default () => {};\n");
  writeFileSync(join(agentDir, "extensions", "sub", "b.md"), "# hello\n");
  writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ p: { key: "sk-LEAK-CANARY" } }));
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify(
      {
        enabled: true,
        remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi" },
        scope: ["."],
        includeSessions: false,
        encrypt: false,
        keepVersions: 3,
        backupOnExit: true,
        backupOnExitMinIntervalMinutes: 0,
      },
      null,
      2,
    ),
  );
  const env = { PI_CODING_AGENT_DIR: agentDir };
  // 父进程也要指向同一个 agentDir，否则 setDpapiSecret 会写到真实 ~/.pi/agent
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // 1. check
  const chk = await runCli(["check", "--json"], env);
  const chkJson = lastJson(chk.stdout);
  check("check 退出码 0", chk.code === 0, `code=${chk.code} ${chk.stderr}`);
  check("check 认证通过", chkJson.ok === true, JSON.stringify(chkJson));

  // 2. 错误密码
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify(
      { remote: { url: baseUrl, username: "user", password: "nope", remoteDir: "bk", remoteName: "pi" } },
      null,
      2,
    ),
  );
  const bad = await runCli(["check", "--json"], env);
  const badJson = lastJson(bad.stdout);
  check("错误密码退出码非 0", bad.code !== 0);
  check("错误密码提示 401", /401|认证/.test(String(badJson.error)), JSON.stringify(badJson));

  // 3. 正常配置下的备份（模拟扩展退出时的调用）
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify(
      {
        enabled: true,
        remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi" },
        scope: ["."],
        includeSessions: false,
        encrypt: false,
        keepVersions: 3,
        backupOnExit: true,
        backupOnExitMinIntervalMinutes: 0,
      },
      null,
      2,
    ),
  );
  const bk = await runCli(["backup", "--reason", "exit", "--json"], env);
  const bkJson = lastJson(bk.stdout);
  check("退出备份退出码 0", bk.code === 0, `code=${bk.code} ${bk.stderr}`);
  check("退出备份成功", bkJson.ok === true, JSON.stringify(bkJson));
  check("退出备份有远端路径", typeof bkJson.remotePath === "string", JSON.stringify(bkJson));
  check("退出备份已脱敏 auth.json", Number(bkJson.redacted) > 0, `redacted=${bkJson.redacted}`);

  // 4. 归档内容确实脱敏 + 排除生效
  const archiveName = String(bkJson.archive);
  const blob = dav.store.get(`/dav/bk/${archiveName}`);
  check("远端存在该归档", !!blob);
  if (blob) {
    const text = gunzipSync(blob).toString("latin1");
    check("归档不含明文密钥", !text.includes("sk-LEAK-CANARY"), "密钥泄漏！");
    check("归档含 extensions/a.ts", text.includes("extensions/a.ts"));
    check("归档含嵌套文件", text.includes("extensions/sub/b.md"));
    check("归档写入备份者自身配置", text.includes("webdav-backup.json"));
    check("归档中配置密码被脱敏", !text.includes("\"password\": \"pass\""), "配置密码泄漏！");
  }

  // 5. status
  const st = await runCli(["status", "--json"], env);
  const stJson = lastJson(st.stdout);
  check("status 返回 lastBackupAt", typeof stJson.state?.lastBackupAt === "string", JSON.stringify(stJson));

  // 6. list
  const ls = await runCli(["list", "--json"], env);
  const lsJson = lastJson(ls.stdout);
  check("list 至少返回 1 个文件", Array.isArray(lsJson.files) && lsJson.files.length >= 1);

  // 7. prune 只保留 1 个
  await new Promise((r) => setTimeout(r, 1100));
  await runCli(["backup", "--reason", "manual", "--json"], env);
  const pr = await runCli(["prune", "--keep", "1", "--json"], env);
  const prJson = lastJson(pr.stdout);
  check("prune 执行成功", prJson.ok === true, JSON.stringify(prJson));
  check("prune 保留了 1 个", prJson.kept === 1, `kept=${prJson.kept}`);

  // 8. dry-run 不写远端
  const beforePut = dav.stats().putCount;
  const dry = await runCli(["backup", "--dry-run", "--json"], env);
  const dryJson = lastJson(dry.stdout);
  check("dry-run 成功", dryJson.ok === true && dryJson.dryRun === true, JSON.stringify(dryJson));
  check("dry-run 未上传", dav.stats().putCount === beforePut);

  // 9. 缺配置时的错误处理
  const emptyDir = mkdtempSync(join(tmpdir(), "pi-cli-empty-"));
  const miss = await runCli(["backup", "--json"], { PI_CODING_AGENT_DIR: emptyDir });
  const missJson = lastJson(miss.stdout);
  check("缺配置时退出码非 0", miss.code !== 0);
  check("缺配置时给出明确错误", /配置文件不存在/.test(String(missJson.error)), JSON.stringify(missJson));

  // 10. 非法 URL 配置
  writeFileSync(
    join(emptyDir, "webdav-backup.json"),
    JSON.stringify({ remote: { url: "ftp://x/y", username: "u", password: "p" } }, null, 2),
  );
  const badUrl = await runCli(["backup", "--json"], { PI_CODING_AGENT_DIR: emptyDir });
  const badUrlJson = lastJson(badUrl.stdout);
  check("非法协议被拒绝", badUrl.code !== 0 && /http/.test(String(badUrlJson.error)), JSON.stringify(badUrlJson));

  // 11. 日志文件确实写入
  const logPath = join(agentDir, "webdav-backup.log");
  check("日志文件已生成", existsSync(logPath));
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8");
    check("日志记录了开始备份", /开始备份/.test(log));
    check("日志记录了完成", /完成|上传中/.test(log));
  }

  // 12. 加密模式经 CLI 全流程，并用库解密回读
  writeFileSync(
    join(agentDir, "webdav-backup.json"),
    JSON.stringify(
      {
        remote: { url: baseUrl, username: "user", password: "pass", remoteDir: "bk", remoteName: "pi-enc" },
        encrypt: true,
        encryptKey: "correct-horse-battery-staple",
      },
      null,
      2,
    ),
  );
  const encRun = await runCli(["backup", "--reason", "manual", "--json"], env);
  const encJson = lastJson(encRun.stdout);
  check("加密备份成功", encJson.ok === true, JSON.stringify(encJson));
  check("加密归档后缀 .pibak", String(encJson.archive).endsWith(".pibak"), String(encJson.archive));

  const encBlob = dav.store.get(`/dav/bk/${encJson.archive}`);
  if (encBlob) {
    const { decryptFile } = await import("./crypto.mjs");
    const encTmp = join(agentDir, "rt.pibak");
    const outTmp = join(agentDir, "rt.tar.gz");
    writeFileSync(encTmp, encBlob);
    await decryptFile(encTmp, outTmp, "correct-horse-battery-staple");
    const plain = gunzipSync(readFileSync(outTmp)).toString("latin1");
    check("CLI 加密归档可解密回读", plain.includes("extensions/a.ts"));
    check("解密后仍无明文密钥", !plain.includes("sk-LEAK-CANARY"));

    let wrongOk = false;
    try {
      await decryptFile(encTmp, join(agentDir, "rt2.tar.gz"), "wrong-key-wrong-key");
      wrongOk = true;
    } catch {
      wrongOk = false;
    }
    check("错误密钥解密被拒绝", wrongOk === false);
  } else {
    check("CLI 加密归档存在", false, "未找到加密归档");
  }

  // 13. DPAPI 引用端到端（验证子进程可解密 → 实际生产路径）
  const { setDpapiSecret, dpapiAvailable, deleteDpapiSecret } = await import("./secrets.mjs");
  if (dpapiAvailable()) {
    setDpapiSecret("cli-e2e-password", "pass");
    writeFileSync(
      join(agentDir, "webdav-backup.json"),
      JSON.stringify(
        {
          remote: {
            url: baseUrl,
            username: "user",
            password: "dpapi:cli-e2e-password",
            remoteDir: "bk",
            remoteName: "pi-dpapi",
          },
          keepVersions: 2,
        },
        null,
        2,
      ),
    );
    check("配置文件不含明文密码", !readFileSync(join(agentDir, "webdav-backup.json"), "utf8").includes('"pass"'));

    const dpChk = await runCli(["check", "--json"], env);
    check("DPAPI 密码可通过子进程认证", lastJson(dpChk.stdout).ok === true, dpChk.stdout.trim());

    const dpBk = await runCli(["backup", "--reason", "exit", "--json"], env);
    check("DPAPI 密码可完成退出备份", lastJson(dpBk.stdout).ok === true, lastJson(dpBk.stdout).error ?? "");

    // 凭证错误时应报认证失败（而不是谜之错误）
    setDpapiSecret("cli-e2e-password", "wrong-password");
    const dpBad = await runCli(["check", "--json"], env);
    const dpBadJson = lastJson(dpBad.stdout);
    check("DPAPI 错误密码报 401", dpBad.code !== 0 && /401|认证/.test(String(dpBadJson.error)), JSON.stringify(dpBadJson));

    // 引用不存在的密钥时应阻断而非静默空密码
    writeFileSync(
      join(agentDir, "webdav-backup.json"),
      JSON.stringify(
        { remote: { url: baseUrl, username: "user", password: "dpapi:no-such-entry", remoteDir: "bk" } },
        null,
        2,
      ),
    );
    const dpMiss = await runCli(["backup", "--json"], env);
    const dpMissJson = lastJson(dpMiss.stdout);
    check("引用缺失密钥时失败", dpMiss.code !== 0, JSON.stringify(dpMissJson));
    check("错误信息指明密钥名", /no-such-entry/.test(String(dpMissJson.error)), JSON.stringify(dpMissJson));

    deleteDpapiSecret("cli-e2e-password");

    // doctor 报告应把明文标出来
    writeFileSync(
      join(agentDir, "webdav-backup.json"),
      JSON.stringify({ remote: { url: baseUrl, username: "user", password: "plaintext-pw", remoteDir: "bk" } }),
    );
    const doc = await runCli(["doctor", "--json"], env);
    const docJson = lastJson(doc.stdout);
    check("doctor 识别明文密码", docJson.password?.plaintext === true, JSON.stringify(docJson.password));

    writeFileSync(
      join(agentDir, "webdav-backup.json"),
      JSON.stringify({ remote: { url: baseUrl, username: "user", password: "$PI_TEST_CLI_PW", remoteDir: "bk" } }),
    );
    const doc2 = await runCli(["doctor", "--json"], { ...env, PI_TEST_CLI_PW: "pass" });
    const doc2Json = lastJson(doc2.stdout);
    check("doctor 识别 env 来源", doc2Json.password?.source === "env", JSON.stringify(doc2Json.password));
    check("doctor env 密码不算明文", doc2Json.password?.plaintext === false);
  } else {
    lines.push("  ⏭  跳过 DPAPI 端到端（非 Windows）");
  }

  dav.server.close();
  try {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(lines.join("\n"));
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(lines.join("\n"));
  console.error(`\n测试异常：${e?.stack ?? e}`);
  process.exit(1);
});
