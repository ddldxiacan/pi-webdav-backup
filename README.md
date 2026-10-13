# pi WebDAV 备份扩展

把 pi 的**插件、扩展、模型配置**自动备份到任意 WebDAV 服务（坚果云 / Nextcloud / 群晖 / 自建 rclone）。

零第三方依赖，只用 Node 内置模块。密钥默认不明文落盘（DPAPI / 环境变量 / 命令）。

---

## 安装

一行命令（pi 官方包机制）：

```bash
pi install git:github.com/ddldxiacan/pi-webdav-backup@v1        # 永远装最新的 1.x 正式版
```

`@v1` 是**移动主版本 tag**，始终指向最新的 1.x 正式版。以后升级不用改命令：

```bash
pi update --extensions     # 自动升到最新的 v1.x（然后 /reload）
```

只想试一下、不安装（仅本次运行生效）：

```bash
pi -e git:github.com/ddldxiacan/pi-webdav-backup
```

其他方式 / 更细的版本控制：

```bash
pi install git:github.com/ddldxiacan/pi-webdav-backup@v1.1.0   # 钉死某个版本（不自动升级）
pi install git:github.com/ddldxiacan/pi-webdav-backup          # 不钉 ref，直接跟 main 分支
pi install npm:pi-webdav-backup                                # 已发布到 npm 时
pi install /path/to/pi-webdav-backup                           # 本地目录（下载 ZIP 解压后）
```

> `@<ref>` 可以是移动 tag（`@v1`）、具体版本 tag（`@v1.1.0`）、分支或 commit SHA：
> - `@v1` → `pi update --extensions` 会跟到最新的 1.x，**推荐**
> - `@v1.1.0` / commit SHA → 钉死不动；升级需重新 `pi install ...@<新版本>`
> - ref 必须真实存在，写错（如不存在的 tag）会 clone/checkout 失败

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
| `/backup restore` | 交互选择备份并恢复；完成后询问是否**写回当前 pi**（换机一键还原）；如含 `extra/` 数据会询问是否归位；未写回时自动体检恢复目录并询问补装插件 |
| `/backup restore-apply <目录>` | 把恢复目录写回当前 pi 的 agent 目录（覆盖前自动备份） |
| `/backup apply-extras <目录>` | 把恢复目录里 `agentDir` 之外的额外数据（`extra/`）归位到真实路径 |
| `/backup verify` | 配置体检：密钥来源、明文告警、连接性 |
| `/backup plugins` | 插件体检：已声明的插件是否装齐（含逐个依赖查缺失） |
| `/backup repair-plugins` | 补装缺失的插件 / 依赖（`npm install` / `git clone`） |
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
node ~/.pi/agent/extensions/webdav-backup/cli.mjs plugins --json [--dir D:\pi-restore]
node ~/.pi/agent/extensions/webdav-backup/cli.mjs repair-plugins --dry-run [--dir D:\pi-restore]
node ~/.pi/agent/extensions/webdav-backup/cli.mjs apply-extras --dir D:\pi-restore [--dry-run] [--force]
node ~/.pi/agent/extensions/webdav-backup/cli.mjs restore-apply --dir D:\pi-restore [--dry-run] [--force]
node ~/.pi/agent/extensions/webdav-backup/cli.mjs detect-legacy --json
```

输出末行固定是 JSON 汇总（`--json` 时只输出该行，人类模式则前面还有日志行），脚本可直接解析；退出码 0 成功 / 1 失败。

---

## 密钥不明文落盘

`remote.password` 与 `encryptKey` 不直接写明文，而是写**引用**：

| 语法 | 说明 | 适用 |
|---|---|---|
| `dpapi:名称` | Windows DPAPI 用户级加密存入 `secrets.dpapi.json`，本机本用户可解，**无需主密码** | 仅 Windows |
| `$ENV_VAR` / `${ENV_VAR}` | 环境变量（也支持 `$A-$B` 拼接，`$$` 转义） | **跨平台** |
| `file:路径` | 从文件读取（自动去换行；相对路径基于 `~/.pi/agent`） | **跨平台** |
| `!命令` | 执行命令取 stdout（可对接密码管理器 CLI） | **跨平台** |
| `plain:值` | 显式声明明文（会告警，仅调试用） | — |
| 其他值 | 视为明文（**会告警**） | — |

> 该语法与 pi 自身的 `resolve-config-value` 约定一致，`auth.json` 的 `key` 字段也支持 `$ENV_VAR` 与 `!命令`。
>
> ⚠️ **要跨 Windows / Linux / macOS 多机同步，用 `file:` 或 `$ENV`，不要用 `dpapi:`**——同 DPAPI 密文只能在本机本用户解密。
> 详见下文「跨平台密钥（多机同步）」。

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

### 跨平台密钥（多机同步）

`dpapi:` 只能在 Windows 本机本用户解密，**同一份配置在 Linux 上会解析失败**。要在 Windows/Linux/macOS 多机共用一套配置，改用 `file:`（推荐，无需改 shell）或 `$ENV`。

**方案：`file:` 相对引用**（配置里写相对 `agentDir` 的路径，各平台写法一致）

```jsonc
{
  "remote": { "password": "file:secrets/webdav-password.txt" },
  "encrypt": true,
  "encryptKey": "file:secrets/backup-key.txt"
}
```

每台机器各创建一次密钥文件（内容相同）：

```bash
mkdir -p ~/.pi/agent/secrets
printf '%s' '你的加密口令'   > ~/.pi/agent/secrets/backup-key.txt
printf '%s' '你的应用密码'   > ~/.pi/agent/secrets/webdav-password.txt
chmod 600 ~/.pi/agent/secrets/*.txt      # Windows 可忽略
```

> `secrets/**` 默认被排除，**密钥不会随备份上传**。所以新机器必须手动做一次这步（这是唯一的手动环节）。
> 读取时会自动去掉行尾换行，`echo`/`printf` 都可以。

**方案：`$ENV`**

配置里写 `"encryptKey": "$PI_WEBDAV_BACKUP_KEY"`，然后各机器设同名环境变量（值相同）：

```bash
# Linux / macOS：~/.bashrc 或 ~/.zshrc
export PI_WEBDAV_BACKUP_KEY="你的加密口令"

# Windows PowerShell（需新开终端生效）
setx PI_WEBDAV_BACKUP_KEY "你的加密口令"
```

从现有 `dpapi:` 迁移：`node cli.mjs migrate --method file`（写入 `secrets/`）或 `--method env`（写入用户环境变量）。

---

## 备份什么

默认备份 `~/.pi/agent/` 下**除以下内容外**的所有文件：

| 排除项 | 原因 |
|---|---|
| `sessions/**` | 会话历史，通常很大（可用 `includeSessions` 打开） |
| `tmp/**`、`web-search-cache/**` | 缓存 |
| `**/node_modules/**` | 可重装（但**开 `includePlugins` 后会一并备份**，见下文） |
| `bin/**` | pi 自动管理的 `fd`/`rg` 二进制，换机后会重新下载（约 8MB） |
| `**/*.log` | 日志 |

包含：`extensions/`（你写的扩展）、`models.json`、`models-store.json`、`settings.json`、`trust.json`、`auth.json`、`npm/package.json` 等。

> **想换机一键还原？** 打开 `includePlugins: true`，把插件实现代码（`node_modules`）也备份进去，
> 新电脑恢复后插件即可直接用，无需联网重装。详见下文「换机一键还原」。

### 插件数据写在 `~/.pi/agent` 之外怎么办（`extraScope`）

有些插件把配置/数据写在 agent 目录之外，默认 `scope: ["."]` 够不到：

| 路径 | 谁写在这里 |
|---|---|
| `~/.pi/settings.json` | pi 旧版本遗留的包声明（`~/.pi/npm/` 同理） |
| `~/.pi/web-search.json` | `pi-web-access` 的回退位置 |
| `~/.config/rpiv-*/config.json` | `@juicesharp/rpiv-*` 系列（XDG 配置） |

用 `extraScope` 把这些**绝对路径（或 `~/...`）**一并备份；归档内统一放在 `extra/` 前缀下：

```jsonc
{
  "extraScope": [
    "~/.pi/settings.json",
    "~/.pi/web-search.json",
    "~/.config/rpiv-todo"
  ]
}
```

- 备份时：`extra/` 内的 JSON/配置会按字段名（`key`/`token`/`password`/`apiKey`…）脱敏
- 恢复时：默认只解到恢复目录；`/backup restore` 会询问是否**归位**到真实路径，也可手动
  `node cli.mjs apply-extras --dir <恢复目录>`
- **跨机可移植**：备份时会把每个文件的归属记成“锚点 + 尾巴”（`home` / `config`(XDG) / `appdata`），
  恢复时按**当前机器**的锚点重算目标。换用户名、换盘符、Linux↔Windows 都能正确归位：
  - 旧机 `/home/alice/.pi/settings.json` → 新机 `/home/bob/.pi/settings.json`
  - 旧机 `C:/Users/alice/.pi/settings.json` → 新机 `D:/Users/carol/.pi/settings.json`
  - 不在任何锚点下的绝对路径（如 `/etc/foo`）保持原样，并在结果里标为 `unmapped` 以便你核对
- 安全：若本地已存在“真实值”、而归档里是 `__REDACTED__`，归位会**跳过**该文件（除非加 `--force`），
  以免把真密钥覆盖成占位符；覆盖前会把原文件存为 `<name>.bak-extras-<时间戳>`
- 探测遗留配置：`/backup-setup` 会自动检测并询问是否纳入；也可 `node cli.mjs detect-legacy`

> 归档里的 `extra-manifest.json` 记录了源机器的 `platform`/`hostname`/`home` 与各锚点，
> 归位时会打印出来，便于确认“这次恢复来自哪台机器”。

### 插件（install 装的包）会怎样

插件是否连同**实现代码（`node_modules`）**一起备份，由 `includePlugins` 决定：

| `includePlugins` | 备份里有什么 | 恢复后 |
|---|---|---|
| `false`（默认，瘦备份） | 声明 + `git:` 源码；npm 包只有 `package.json`/lockfile | 插件实现不在，需联网 `/backup repair-plugins` 补装 |
| `true`（推荐，换机一键还原） | 连同 `node_modules` 一起 | 插件直接可用，无需联网 |

开启 `includePlugins: true` 时，会保留 `npm/node_modules/**`、`git/**/node_modules/**`，仅排除其中运行时用不到、
体积大的内部数据（`**/.git/**`、`node_modules/.cache`、`.vite`、`.turbo`、`.bin`）。

> **取舍**：`true` 能实现真正的一键还原，代价是体积变大（有原生依赖时可能几百 MB，且同一份备份在
> 不同平台间可能带入不兼容的二进制）。`false` 体积小，但恢复后必须联网补装。
>
> 无论哪种模式，`/backup restore` 都不再强制联网：开启 `includePlugins` 后，恢复流程会检测到
> 备份里已含插件代码并跳过补装提示。

### 敏感文件脱敏（重要）

备份时（**加密与否都会**），`auth.json`、`webdav-backup.json` 以及 `extraScope` 下的 JSON/配置会先脱敏再上传：

- 按字段名匹配：`key` / `token` / `secret` / `password` / `credential` / `cookie` / `apiKey` / `private` …
- **未加密时**还额外按值的形状匹配：`sk-…`、`ghp_…`、`AIza…`、JWT、32 位以上随机串
- 命中替换为 `__REDACTED__`，结构保留；密钥**引用**（`$ENV` / `dpapi:` / `file:`）不会被抹
- 解析失败时整文件替换为占位符，**绝不原样上传**

> 因为加密备份同样会脱敏，**用明文写的 API key / 密码无法从备份恢复**（会变成 `__REDACTED__`）。
> 建议一律用 `$ENV` / `dpapi:` 引用（引用会被保留，恢复后仍可用）。
> 脱敏是「尽力而为」的防泄漏措施，真正的安全做法是开启 `encrypt`。

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
  "extraScope": [],                // agentDir 之外的额外备份路径（绝对路径或 ~/...），见上文「插件数据」
  "includePlugins": false,         // 是否把插件实现（node_modules）一起备份（换机一键还原的关键），见上文
  "includeSessions": false,        // 是否备份会话历史
  "snapshot": false,               // 见下文「两种模式」

  "encrypt": false,                // AES-256-GCM 加密
  "encryptKey": "dpapi:backup-key",  // 密钥引用（≥16 位）：dpapi:名称 / $ENV_VAR / file:路径；见上文「密钥」

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

> ⚠️ 密码建议用引用而非明文（**多机同步请用 `file:` / `$ENV`，不要用 `dpapi:`**）：
> ```
> /backup keys set webdav-password          # Windows DPAPI
> # 跨平台："password": "file:secrets/webdav-password.txt"
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
/backup restore          # 选择备份 → 恢复 → 询问是否写回当前 pi
```

恢复分两步：先解到临时目录（不会直接动你的现有配置），再由你确认后才写回 `~/.pi/agent`。
写回前每个被覆盖的旧文件都会另存为 `<名字>.bak-apply-<时间戳>`。

**换机一键还原（推荐）**：新电脑装好 pi → `/backup-setup` 配好同一 WebDAV → `/backup restore -y`：

```
/backup restore
  ├─ 选备份（`-y` 直接取最新）→ 解压到临时目录
  ├─ 本机已装插件时选【合并 / 替换】（见下）
  ├─ 询问是否【写回当前 pi】（restore-apply）
  │    ├─ 是：把配置/扩展/插件实现写回 ~/.pi/agent（覆盖前自动备份）
  │    └─ 否：只留在临时目录，你自己拷
  ├─ 如含 extra/ 额外数据（~/.pi/settings.json 等）→ 询问是否归位
  └─ 若备份已含插件代码 → 完成；否则体检并询问联网补装
/reload                  # 重启 pi 后插件即可用
```

前置条件：备份时开启了 `includePlugins: true`，插件实现才会在备份里；否则写回后仍需联网补装。

#### 本机已经装了插件时，写回（合并 vs 替换）

新电脑往往已经装过一些插件——可能和备份里同名但版本不同，也可能多装了备份里没有的。
直接覆盖会**把同名插件降级、把本机多装的声明抹掉、留下版本混合的“缝合”目录**。所以写回有两种模式：

| 模式 | settings.json 的 packages | npm/package.json 的 dependencies | 本机已装的插件实现 | 本机多装的插件 |
|---|---|---|---|---|
| **合并**（默认，推荐） | 本机声明优先，追加备份里本机没有的 | 本机依赖优先，追加备份里本机没有的 | **保留本机版本**，不覆盖 | 保留（声明与代码都留） |
| 替换（旧机原样） | 完全用备份版 | 完全用备份版 | 被备份覆盖（同名降级） | 声明被移除（代码不删） |

> **为何要合并 `npm/package.json`**：pi 启动时会拿它与 `node_modules` 做协调（npm install）。
> 若直接覆盖成备份版，本机独有的插件会被 npm 当成多余包【卸载】。所以合并模式会保留本机已有依赖。

- 交互式 `/backup restore`：本机有插件声明时会先让你选（默认合并）
- 命令行：`--mode merge`（默认）/ `--mode replace`

> “合并”对**已安装**的插件只保声明与代码、不升级也不降级；备份里本机没有的插件则连代码一起补入。
> 想完全回到旧机器状态（含同名降级）用“替换”。两种模式都不会删除本机多装的插件**代码**，
> 只会（在替换时）从其 `settings.json` 声明里移除。

手动写回某个已恢复目录（不重新下载）：

```
/backup restore-apply <目录>
# 或命令行：
node cli.mjs restore-apply --dir D:\pi-restore [--dry-run] [--force] [--mode merge|replace]
```

写回的安全规则：

- 只写回 agent 目录内的内容；`extra/`（agentDir 之外）由 `apply-extras` 单独处理
- 自动跳过备份/恢复产生的元数据（manifest、state、log）
- 目标已存在且内容不同时，先备份旧文件再覆盖（`.bak-apply-*`）
- 归档里是 `__REDACTED__` 而本地有真实值时跳过（除非 `--force`），避免把真密钥抹掉
- 合并模式下，本机已装插件的目录整体保留，不写入备份里的同名文件（避免版本混合）

> 若只想解到指定目录、不写回：
> ```bash
> node cli.mjs restore --file pi-agent-20260924-120000.tar.gz --to D:\pi-restore
> ```

### 恢复后把插件装回来（仅瘦备份需要）

如果备份时**没有**开启 `includePlugins`，插件实现代码 `node_modules` 不在备份里，需要联网补装。
恢复后跑（`--dir` 指向刚恢复出来的目录，不加则看当前 `~/.pi/agent`）：

```
/backup plugins          # 看哪些插件没装好
/backup repair-plugins   # 补装

node cli.mjs plugins --json --dir D:\pi-restore        # 命令行同理
node cli.mjs repair-plugins --dir D:\pi-restore
```

会做的事（安装命令与 pi 自身的安装逻辑保持一致）：

| 情况 | 动作 |
|---|---|
| npm 包装在 `settings.json` 里、但 `npm/node_modules` 里没有 | `npm install <包>[@版本] --legacy-peer-deps`（在 `<目录>/npm`） |
| git 包目录不存在 | `git clone --depth 1 [--branch <ref>]`；ref 不是分支/标签（如 commit SHA）时自动回退为完整 clone + `git checkout` |
| git 包目录在、但缺依赖（逐个依赖名检测，拷了一半也能查出来） | 在该包目录内 `npm install --omit=dev` |

`--dry-run` 只列将执行的命令，不落盘；单个包失败不影响其余，结果里会分开报 `repaired` / `failed`。

> 来源解析与 pi 的 `parseGitUrl` 完全对齐：支持 `git:` 简写、`https://…` URL、`git@host:path` scp 形式，
> ref 可含 `/`（如 `feature/x`），`.git` 后缀自动去掉（否则会装到 pi 找不到的目录）。

> `/backup restore` 在**未写回**时会自动体检**刚恢复出来的目录**并询问是否立即补装（体检的是临时目录，
> 而不是当前 `~/.pi/agent`，因为声明还在临时目录里）；若已写回当前目录，则看点目录。
> `/backup restore -y` 只略过「恢复哪个」的询问，写回与补装仍会各自询问一次。

### 加密备份的恢复

需要 `encryptKey` 一致（配置文件或 `$PI_WEBDAV_BACKUP_KEY`）。密钥不对会明确报错，不会写出损坏文件。

解包过程会**拒绝绝对路径与 `..` 穿越**，防止恶意归档写出到目标目录之外。

---

## 多机同步（Windows ↔ Linux）

⚠️ 先认清本质：**这是"备份/恢复"，不是实时双向同步。**

| 命令 | 方向 |
|---|---|
| `/backup` | 本机 → 云端（上传） |
| `/backup restore` | 云端 → 本机（下载，默认合并） |

两台机器各自 `/backup` 会互相覆盖，建议**以一台为主机**，其他机器只做 `/backup restore`。

### 一、旧机（主机）：先备份

```
/backup dry        # 确认扫描结果（开了 includePlugins 会含几百 MB 插件代码）
/backup            # 正式备份
```

### 二、新机：安装 + 恢复

```bash
# 1. 装插件（GitHub / npm 二选一）
pi install git:github.com/ddldxiacan/pi-webdav-backup@v1
# 然后重启 pi

# 2. 创建密钥文件（内容与旧机一致；secrets/ 不入备份，故需手动一次）
mkdir -p ~/.pi/agent/secrets
printf '%s' '你的加密口令' > ~/.pi/agent/secrets/backup-key.txt
printf '%s' '你的应用密码' > ~/.pi/agent/secrets/webdav-password.txt
chmod 600 ~/.pi/agent/secrets/*.txt

# 3. 写配置 ~/.pi/agent/webdav-backup.json（与旧机相同，密钥用 file:）
```

配置文件模板（Windows/Linux 通用）：

```jsonc
{
  "enabled": true,
  "remote": {
    "url": "https://你的.webdav/dav",
    "username": "you@example.com",
    "password": "file:secrets/webdav-password.txt",
    "remoteDir": "pi-backup",
    "remoteName": "pi"
  },
  "scope": ["."],
  "includePlugins": true,
  "extraScope": ["~/.pi/settings.json"],
  "encrypt": true,
  "encryptKey": "file:secrets/backup-key.txt",
  "includeSessions": false
}
```

```
# 4. 测连接 + 恢复
/backup check
/backup restore -y     # 选备份 → 解密解压 → 选合并/替换 → 写回 → 归位 extra → 完成
/reload
```

### 三、关键约束

| 项 | 要求 |
|---|---|
| `encryptKey` | **两台机器值必须一致**，否则解不开加密备份 |
| 密钥引用 | 多机一律用 `file:` 或 `$ENV`，**不要用 `dpapi:`**（只能本机解密） |
| `remote.url` / `remoteDir` / `remoteName` | 两台机器必须完全一致，否则找不到备份 |
| 插件还原 | 旧机需开 `includePlugins: true`；否则新机恢复后要联网 `/backup repair-plugins` |
| 合并/替换 | 新机已装插件时，默认"合并"（保留本机已装的，只补缺失） |

### 四、常见坑

| 症状 | 处理 |
|---|---|
| 新机报"加密密钥解析失败" | 用了 `dpapi:` 但非 Windows；改用 `file:` / `$ENV` |
| 解密失败 | `backup-key` 与旧机不一致（或旧备份用了更早的口令） |
| 恢复后插件不生效 | 旧机未开 `includePlugins` → `/backup repair-plugins` 联网补装 |
| 恢复后缺插件声明 | 插件声明在 `~/.pi/settings.json`（非 agent）→ 加入 `extraScope` |
| 连接 401 | WebDAV 密码错（坚果云要用**应用密码**） |

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

11 个测试文件、450+ 项断言，用内置的内存 WebDAV 服务端做真实 HTTP 往返：

| 文件 | 覆盖 |
|---|---|
| `test.mjs` | 收集/排除、归档、加密往返、快照增量、prune |
| `test-cli.mjs` | 真实子进程调用 CLI、退出备份、DPAPI 端到端、doctor、日志、状态 |
| `test-restore.mjs` | 归档/加密/快照恢复、目录穿越防护、302 重定向（对象存储）恢复 |
| `test-plugins.mjs` | 插件声明解析（与 pi 官方 parseGitUrl 对齐：`.git` 后缀、ref 含 `/`、URL/scp 来源）、恢复后体检（缺安装/逐个依赖查缺依赖）、补装、SHA ref 回退、dry-run、真实恢复往返 |
| `test-apply.mjs` | 换机一键还原：`includePlugins` 排除组装与收集、含插件归档往返恢复、`restore-apply` 写回/覆盖前备份/幂等/dry-run/防止 `__REDACTED__` 覆盖真值、跳过 `extra/` 与元数据 |
| `test-extras.mjs` | `agentDir` 之外的额外数据（`extraScope`）：路径映射互逆、**跨机锚点重映射**（换用户名/盘符/平台）、收集、脱敏、恢复归位、幂等、`--force` 安全防护、遗留配置探测 |
| `test-redact.mjs` | 脱敏（含「字段名无关但值是密钥」的回归用例） |
| `test-json.mjs` | CLI 输出 JSON 解析容错（回归：空输出曾抛裸 JSON 错误吞掉 stderr） |
| `test-empty-cmd.mjs` | 空参数/子命令解析、输出契约（回归：`/backup` 不带参数曾报「未知命令：」、完成提醒拿不到 JSON 汇总） |
| `test-secrets.mjs` | dpapi/$ENV/file/!命令/plain 各分支、明文告警、三种迁移方式 |
| `test-auth-migrate.mjs` | `auth.json` 明文密钥审计与迁移（迁移前自动备份、可回滚） |

---

## 版本历史

| 版本 | 内容 |
|---|---|
| **v1.3.3** | **修复合并模式会卸载本机插件**：`restore-apply` 合并模式此前只合并 `settings.json`，却用备份版**覆盖** `npm/package.json`——pi 下次启动的 npm 协调会把本机独有插件当成多余包卸载（实测于 Windows→Linux 同步）。现改为同时合并 `npm/package.json` 的 `dependencies`（本机优先），结果里标 `npm-dependencies`。另：文档补充「多机同步」与「跨平台密钥」流程 |
| **v1.3.2** | **跨平台多机同步**：依赖体检修正（npm 提升到父级的依赖不再误报为缺失，按 Node 模块解析算法沿祖先 `node_modules` 查找）；文档新增「跨平台密钥（多机同步）」与「多机同步（Windows ↔ Linux）」流程，明确多机用 `file:` / `$ENV` 而非 `dpapi:`，并给出常见坑 |
| **v1.3.1** | 依赖体检误报修正（npm 提升的依赖被当成缺失） |
| **v1.3.0** | **换机一键还原**：新增 `includePlugins`（把插件实现 `node_modules` 一并备份，重机恢复即可直接用，无需联网重装）；新增 `restore-apply` / `/backup restore-apply`（把恢复结果写回当前 `~/.pi/agent`，覆盖前备份、幂等、防止 `__REDACTED__` 覆盖真值）；**写回默认【合并模式】**：本机已装插件保留不被覆盖、`settings.json` 只合并 `packages`（避免删掉/降级本机插件），可选 `--mode replace` 完全还原；`/backup restore` 默认询问是否写回当前 pi，已含插件时不再提示联网补装；`/backup-setup` 向导新增插件代码选项；脱敏审计跳过第三方插件代码（避免误报）；排除规则重构（`includePlugins` 开关控制 node_modules） |
| **v1.2.0** | **插件数据跨机同步补齐**：新增 `extraScope`（备份 `agentDir` 之外的路径，如 `~/.pi/settings.json`、`~/.config/rpiv-*`，归档内放 `extra/` 前缀）；归档写入 `extra-manifest.json`，按 `home`/`config`(XDG)/`appdata` 锚点记录归属，恢复时按当前机器重算目标（换用户名/盘符/平台均可）；`/backup apply-extras` 归位（幂等、覆盖前备份、防止 `__REDACTED__` 覆盖真密钥、支持 `--force`、未映射路径单独提醒）；新增 `detect-legacy` 探测遗留配置；`/backup-setup` 引导纳入；默认排除新增 `bin/**`；README 澄清加密备份同样会脱敏 |
| **v1.1.0** | **插件备份/恢复修好**：恢复后自动体检「恢复出来的目录」并补装（此前看错目录，补装提示永不出现）；`plugins`/`repair-plugins` 新增 `--dir`；git 来源解析与 pi 完全对齐（`.git` 后缀、ref 含 `/`、`https://`/scp 形式）；commit SHA ref 自动回退为完整 clone + checkout；缺依赖逐个检测；安装参数对齐 pi（`--legacy-peer-deps` / `--omit=dev`）；Windows 路径含空格不再报错。另含 v1.0.2 之后的修复：恢复遇 302 重定向到对象存储自动跟随（不外泄凭据）、完成通知拿不到汇总的回归 |
| **v1.0.2** | 初始发布：归档/快照两种备份模式、AES-256-GCM 加密、DPAPI/环境变量/命令密钥、明文脱敏、退出自动备份与每日定时备份、恢复到临时目录 |

> 发新版时：打新 tag（如 `v1.1.1`）后把移动 tag `v1` 一并指过去，让 `pi install …@v1` 始终装最新：
> `git tag -f v1 v1.1.1 && git push -f origin v1`

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
| 恢复报 `HTTP 302` | Cloudreve/群晖等把下载重定向到对象存储（腾讯云 COS 等）；客户端已自动跟随跨主机 302（不携带凭据），请升级到 v1.1.0+ |
| 恢复后插件不生效 | 若备份时未开启 `includePlugins`，插件代码（`node_modules`）不在备份里，需联网补装：`/backup repair-plugins`（可带 `--dir`）。推荐下次备份开启 `includePlugins: true`，下次即可一键还原 |
| 写回时提示跳过某些文件 | 归档里是 `__REDACTED__` 而本地已有真实密钥时会被跳过（避免把真密钥抹掉）；确认要覆盖可加 `--force` |
| 补装报 `git clone` 失败 | 确认能访问 github.com 等源；ref 是 commit SHA 时会自动回退为完整 clone + checkout，仍失败则看日志里的 git 输出 |
| 插件体检一直报「缺少安装」 | 多半是 `.git` 后缀 / ref 形式的声明被装到了 pi 找不到的目录；v1.1.0+ 已与 pi 的解析对齐，升级后跑一次 `/backup repair-plugins` |
| 配置体检 | `/backup verify` 一次看全部状态 |
