# pi WebDAV 备份扩展

把 pi 的**插件、扩展、模型配置**自动备份到任意 WebDAV 服务（坚果云 / Nextcloud / 群晖 / 自建 rclone）。

零第三方依赖，只用 Node 内置模块。密钥默认不明文落盘（DPAPI / 环境变量 / 命令）。

---

## 安装

一行命令（pi 官方包机制）：

```bash
pi install git:github.com/ddldxiacan/pi-webdav-backup@v1
```

只想试一下、不安装（仅本次运行生效）：

```bash
pi -e git:github.com/ddldxiacan/pi-webdav-backup
```

其他方式：

```bash
pi install npm:pi-webdav-backup            # 已发布到 npm 时
pi install /path/to/pi-webdav-backup       # 本地目录（下载 ZIP 解压后）
```

手动安装：把 `extensions/webdav-backup.ts` 与 `extensions/webdav-backup/` 拷到 `~/.pi/agent/extensions/`。

装好后在 pi 里运行 **`/reload`** 加载。

> 本包带 `pi-package` 关键字，会出现在 [pi.dev 包画廊](https://pi.dev/packages)。

运行时产生的文件：

```
~/.pi/agent/webdav-backup.json        ← 备份配置（/backup-setup 生成）
~/.pi/agent/secrets.dpapi.json        ← DPAPI 加密的密钥（自动创建，0600）
```

---

## 快速开始

```
/backup-setup       # 向导：填地址、账号、密码（默认 DPAPI 加密保存），自动测连接
/backup             # 立即备份
/backup verify      # 体检：密钥来源 / 明文告警 / 连接性
/backup check       # 单独测连接
/backup list        # 看远端已有备份
/backup restore     # 选一个备份恢复到临时目录
```

配置写入 `~/.pi/agent/webdav-backup.json`。

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `/backup` | 立即备份（同步执行，完成后通知） |
| `/backup check` | 测试 WebDAV 连通性与认证 |
| `/backup list` | 列出远端备份文件 |
| `/backup dry` | 试运行：只扫描统计，不上传 |
| `/backup status` | 查看上次备份时间 |
| `/backup prune` | 清理旧备份（保留 `keepVersions` 个） |
| `/backup restore` | 交互选择备份并恢复到临时目录 |
| `/backup verify` | 配置体检：密钥来源、明文告警、连接性 |
| `/backup plugins` | 插件体检：已声明的插件是否装齐（含缺失依赖） |
| `/backup repair-plugins` | 补装缺失的插件 / 依赖（`npm install`） |
| `/backup keys list` | 列出已加密保存的密钥 |
| `/backup keys set <名称>` | 用 DPAPI 加密保存密钥 |
| `/backup keys rm <名称>` | 删除密钥 |
| `/backup keys migrate` | 把配置里的明文密钥迁成加密引用 |
| `/backup-setup` | 配置向导（默认走 DPAPI 加密） |
| `/backup-cron [HH:MM]` | 安装每日定时备份（Windows 计划任务） |
| `/backup-cron remove` | 移除定时任务 |
| `/backup-log` | 查看最近 20 行日志 |

命令行也可直接用：

```bash
node ~/.pi/agent/extensions/webdav-backup/cli.mjs backup --json
node ~/.pi/agent/extensions/webdav-backup/cli.mjs doctor --json
node ~/.pi/agent/extensions/webdav-backup/cli.mjs migrate --method dpapi
node ~/.pi/agent/extensions/webdav-backup/cli.mjs restore --list
node ~/.pi/agent/extensions/webdav-backup/cli.mjs restore --file pi-agent-20260924-120000.tar.gz --to D:\restore
node ~/.pi/agent/extensions/webdav-backup/cli.mjs plugins --json
node ~/.pi/agent/extensions/webdav-backup/cli.mjs repair-plugins --dry-run
```

输出末行固定是 JSON 汇总（`--json` 时只输出该行，人类模式则前面还有日志行），脚本可直接解析；退出码 0 成功 / 1 失败。

---

## 密钥不明文落盘

`remote.password` 与 `encryptKey` 不直接写明文，而是写**引用**：

| 语法 | 说明 | 适用 |
|---|---|---|
| `dpapi:名称` | **推荐**。Windows DPAPI 用户级加密存入 `secrets.dpapi.json`，本机本用户可解，**无需主密码** | Windows |
| `$ENV_VAR` / `${ENV_VAR}` | 环境变量（也支持 `$A-$B` 拼接，`$$` 转义） | 跨平台 |
| `file:路径` | 从文件读取（自动去换行；相对路径基于 `~/.pi/agent`） | 跨平台 |
| `!命令` | 执行命令取 stdout（可对接密码管理器 CLI） | 跨平台 |
| `plain:值` | 显式声明明文（会告警，仅调试用） | — |
| 其他值 | 视为明文（**会告警**） | — |

> 该语法与 pi 自身的 `resolve-config-value` 约定一致，`auth.json` 的 `key` 字段也支持 `$ENV_VAR` 与 `!命令`。

### 推荐做法

```jsonc
{
  "remote": {
    "url": "https://dav.jianguoyun.com/dav/",
    "username": "you@example.com",
    "password": "dpapi:webdav-password"      // 不是明文
  },
  "encrypt": true,
  "encryptKey": "dpapi:backup-key"           // 不是明文
}
```

密钥本身这样存：

```
/backup keys set webdav-password      # 提示输入，DPAPI 加密入库
/backup keys set backup-key
/backup keys list                     # 只看名称与时间，不显示明文
```

已有明文配置？一条命令迁走（自动备份原文件）：

```
/backup keys migrate
```

非 Windows 或偏好环境变量：

```bash
node cli.mjs migrate --method env    # 写入用户环境变量（setx）
node cli.mjs migrate --method file   # 写入 0600 权限的 secrets/ 目录
```

### 体检

```
/backup verify
```

输出密钥来源、是否明文、DPAPI 是否可用、连接是否通过。有明文会直接标 ⚠️。

> **DPAPI 的边界**：防御的是「配置文件/备份被拷走或误传到云端」。不防御已经能以你的身份运行代码的本机恶意程序。若需更强隔离，用 `!命令` 对接外部密码管理器。

### 环境变量方式也支持

不想改配置文件时，仍可用环境变量（优先级低于配置里的值）：

```powershell
setx PI_WEBDAV_BACKUP_PASSWORD "你的应用密码"
setx PI_WEBDAV_BACKUP_KEY "你的加密口令"
```

---

## 备份什么

默认备份 `~/.pi/agent/` 下**除以下内容外**的所有文件：

| 排除项 | 原因 |
|---|---|
| `sessions/**` | 会话历史，通常很大（可用 `includeSessions` 打开） |
| `tmp/**`、`web-search-cache/**` | 缓存 |
| `**/node_modules/**` | 可重装 |
| `**/*.log` | 日志 |

包含：`extensions/`（你写的扩展）、`models.json`、`models-store.json`、`settings.json`、`trust.json`、`auth.json`、`npm/package.json` 等。

### 插件（install 装的包）会怎样

**声明与源码都会备份，但插件实现代码（`node_modules`）不备份** —— 它体积大、含平台相关二进制，而 lockfile 足以重建。

| 插件类型 | 备份里有什么 | 恢复后 |
|---|---|---|
| `git:` | 包源码（`git/**`，含浅克隆 `.git`） | 源码在；但包自己的 `node_modules` 不在，需补装依赖 |
| `npm:` | 仅声明（`npm/package.json` + `package-lock.json`） | 代码全不在，需重新 `npm install` |

因此**恢复后插件不会自动就位**，需要补装。pi 本身只在“git 包目录完全不存在”时才重装；
目录在、只是缺 `node_modules` 时它不会补，插件会静默带病运行（有运行时依赖的包会报错）。

用这两条命令善后：

```
/backup plugins          # 体检：哪些已声明插件没装好
/backup repair-plugins   # 补装（git 缺失则 clone，依赖缺失则 npm install）
```

`/backup restore` 完成后会自动体检并询问是否补装；也可随时手动执行。

> 不想恢复后重建？把 `node_modules` 备份进去需要改代码（`DEFAULT_EXCLUDE` 是内置的，
> 配置里的 `exclude` 只能追加、不能移除），而且会带来两个问题：体积暴涨（本例单个 git 包
> 就 131MB）、跨平台时会带上不兼容的原生二进制。所以推荐「瘦备份 + 恢复后补装」这套流程。

### 敏感文件脱敏（重要）

**未加密**备份时，`auth.json` 与 `webdav-backup.json` 会先脱敏再上传：

- 按字段名匹配：`key` / `token` / `secret` / `password` / `credential` / `cookie` / `private` …
- **并按值的形状匹配**：`sk-…`、`ghp_…`、`AIza…`、JWT、32 位以上随机串
- 命中替换为 `__REDACTED__`，结构保留
- 解析失败时整文件替换为占位符，**绝不原样上传**

> 脱敏是「尽力而为」的防泄漏措施。真正的安全做法是开启 `encrypt`。

---

## 配置项

```jsonc
{
  "enabled": true,

  "remote": {
    "url": "https://dav.jianguoyun.com/dav/",   // 见下方各服务填法
    "username": "you@example.com",
    "password": "dpapi:webdav-password",        // 密钥引用，见上文；留空则读 $PI_WEBDAV_BACKUP_PASSWORD
    "remoteDir": "pi-backup",                    // 远端目录
    "remoteName": "pi-agent"                     // 文件名前缀
  },

  "scope": ["."],                  // 相对 ~/.pi/agent 的路径，可写 ["extensions", "models.json"]
  "exclude": [],                   // 额外 glob 排除规则
  "includeSessions": false,        // 是否备份会话历史
  "snapshot": false,               // 见下文「两种模式」

  "encrypt": false,                // AES-256-GCM 加密
  "encryptKey": "dpapi:backup-key",  // 密钥引用（≥16 位），或 $PI_WEBDAV_BACKUP_KEY

  "backupOnExit": true,            // 退出 pi 时自动备份
  "backupOnExitMinIntervalMinutes": 30,   // 两次自动备份最小间隔
  "backupOnExitTimeoutMs": 600000,        // 自动备份等待上限

  "keepVersions": 10,              // 保留最近 N 个归档（0 = 不清理）
  "timeoutMs": 60000,
  "insecureTls": false             // 自签名证书时才设 true
}
```

### 各服务 URL 填法

| 服务 | url | username | password |
|---|---|---|---|
| **坚果云** | `https://dav.jianguoyun.com/dav/` | 注册邮箱 | **应用密码**（账户信息 → 安全选项 → 添加应用密码） |
| **Nextcloud** | `https://云地址/remote.php/dav/files/<用户名>/` | 用户名 | 登录密码或应用密码 |
| **群晖 WebDAV** | `https://NAS地址:5006/<共享文件夹>` | DSM 账号 | DSM 密码 |
| **自建 rclone serve** | `http://主机:端口/` | `--user` 指定的值 | `--pass` 指定的值 |

> ⚠️ 密码建议用 `dpapi:` 引用而非明文，见下方「密钥不明文落盘」：
> ```
> /backup keys set webdav-password
> # 然后在配置里写 "password": "dpapi:webdav-password"
> ```
> 也可用环境变量：`setx PI_WEBDAV_BACKUP_PASSWORD "你的应用密码"`

---

## 两种备份模式

### 归档模式（默认，`snapshot: false`）

每次打包成一个 `pi-agent-<时间戳>.tar.gz`（可选 `.pibak` 加密）上传。

- ✅ 单个文件，下载/归档方便
- ✅ 天然有版本历史
- ⚠️ 每次全量上传

### 快照模式（`snapshot: true`）

逐文件上传到 `pi-backup/pi-agent/`，用远端 `manifest.json` 做增量比对。

- ✅ 只传变化的文件，第二次起非常快
- ✅ 能单独恢复某一个文件
- ⚠️ 只保留最新状态，无历史版本

**建议**：日常用**快照模式**（省流量），配合每周一次归档（可另配一个 `remoteName`）。

---

## 退出自动备份怎么工作

`session_shutdown`（`reason: quit`）触发时：

1. 检查 `enabled` / `backupOnExit`
2. 距上次自动备份不足 `backupOnExitMinIntervalMinutes` → 跳过（避免反复开关 pi 重复上传）
3. 否则 **spawn 一个分离子进程**执行上传，立刻返回

用分离进程的原因：pi 退出时若被 `SIGTERM`/关窗打断，留在主进程的上传会被中断；分离进程不受影响，且不会卡住退出。

日志写在 `~/.pi/agent/webdav-backup.log`。

### 每日定时备份

```powershell
# 在 pi 里：/backup-cron 03:00     或命令行：
node "$env:USERPROFILE\.pi\agent\extensions\webdav-backup\cli.mjs" install-cron --time 03:00
```

需要管理员权限（创建计划任务）。移除：`/backup-cron remove`。

---

## 恢复

```
/backup restore          # 选择备份 → 恢复到临时目录
```

**默认恢复到临时目录，不会直接覆盖 `~/.pi/agent`** —— 因为恢复旧配置可能覆盖你当前的密钥。

恢复后自行拷贝需要的文件：

```powershell
# 归档恢复结果示例
# C:\Users\...\Temp\pi-restore-XXXX\restored\extensions\...
copy "$env:TEMP\pi-restore-XXXX\restored\extensions\*.ts" "$env:USERPROFILE\.pi\agent\extensions\"
```

指定目标目录（谨慎）：

```bash
node cli.mjs restore --file pi-agent-20260924-120000.tar.gz --to D:\pi-restore
```

### 恢复后把插件装回来

插件声明与源码会随备份回来，但**插件实现代码 `node_modules` 不备份**。恢复到 `~/.pi/agent` 后跑：

```
/backup plugins          # 看哪些插件没装好
/backup repair-plugins   # 补装
```

会做的事：

| 情况 | 动作 |
|---|---|
| npm 包装在 `settings.json` 里、但 `npm/node_modules` 里没有 | `npm install <包>[@版本]`（在 `~/.pi/agent/npm`） |
| git 包目录不存在 | `git clone --depth 1 [--branch <ref>]` |
| git 包目录在、但缺依赖 | 在该包目录内 `npm install` |

`--dry-run` 只列将执行的命令，不落盘；单个包失败不影响其余，结果里会分开报 `repaired` / `failed`。

> `/backup restore` 恢复完会自动体检并询问是否立即补装（`/backup restore -y` 会略过询问）。

### 加密备份的恢复

需要 `encryptKey` 一致（配置文件或 `$PI_WEBDAV_BACKUP_KEY`）。密钥不对会明确报错，不会写出损坏文件。

解包过程会**拒绝绝对路径与 `..` 穿越**，防止恶意归档写出到目标目录之外。

---

## 测试

```bash
cd pi-webdav-backup
npm test
# 等价于：node extensions/webdav-backup/run-tests.mjs
```

扩展契约校验（模拟 pi 加载器导入入口文件）：

```bash
node extensions/webdav-backup/verify-load.mjs
```

8 个测试文件、310 项断言，用内置的内存 WebDAV 服务端做真实 HTTP 往返：

| 文件 | 覆盖 |
|---|---|
| `test.mjs` | 收集/排除、归档、加密往返、快照增量、prune |
| `test-cli.mjs` | 真实子进程调用 CLI、退出备份、DPAPI 端到端、doctor、日志、状态 |
| `test-restore.mjs` | 归档/加密/快照恢复、目录穿越防护、302 重定向（对象存储）恢复 |
| `test-plugins.mjs` | 插件声明解析、恢复后体检（缺安装/缺依赖）、补装、dry-run、真实恢复往返 |
| `test-redact.mjs` | 脱敏（含「字段名无关但值是密钥」的回归用例） |
| `test-json.mjs` | CLI 输出 JSON 解析容错（回归：空输出曾抛裸 JSON 错误吞掉 stderr） |
| `test-empty-cmd.mjs` | 空参数/子命令解析、输出契约（回归：`/backup` 不带参数曾报「未知命令：」、完成提醒拿不到 JSON 汇总） |
| `test-secrets.mjs` | dpapi/$ENV/file/!命令/plain 各分支、明文告警、三种迁移方式 |
| `test-auth-migrate.mjs` | `auth.json` 明文密钥审计与迁移（迁移前自动备份、可回滚） |

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 401 认证失败 | 坚果云必须用**应用密码**；确认 `username` 是邮箱 |
| 404 路径不存在 | 检查 `url` 结尾斜杠与路径；Nextcloud 要带 `/remote.php/dav/files/<用户名>/` |
| 403 拒绝访问 | 远端目录权限不足；坚果云需先在网页版建好目录 |
| TLS 证书错误 | 自签名证书才设 `insecureTls: true`（有中间人风险） |
| 备份很慢 | 改用 `snapshot: true`；或把 `includeSessions` 关掉 |
| 退出时没备份 | 看 `webdav-backup.log`；确认 `backupOnExit: true` 且距上次已过间隔 |
| 想立刻看到日志 | `/backup-log` |
| DPAPI 解密失败 | 密文只能在本机本用户下解；换机器/换用户需重新 `/backup keys set` |
| 提示「环境变量未设置」 | `/backup keys set` 改用 dpapi，或先设好该环境变量 |
| 恢复报 `HTTP 302` | Cloudreve/群晖等把下载重定向到对象存储（腾讯云 COS 等）；客户端已自动跟随跨主机 302（不携带凭据），请升级到 v1.0.3+ |
| 恢复后插件不生效 | 插件代码（`node_modules`）有意不入备份。跑 `/backup plugins` 看哪些没装好，再 `/backup repair-plugins` 补装 |
| 配置体检 | `/backup verify` 一次看全部状态 |
