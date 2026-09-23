<div align="center">

# 新 alice 助手

**Alice Agent 客户端管理助手**

*Portable client manager for AI coding agents — prompts, skill packs, any client*

![status](https://img.shields.io/badge/status-work%20in%20progress-orange?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-1D9E75?style=flat-square)

</div>

---

## 简体中文

### 这是什么

新 alice 助手是一个面向 Windows 的便携式桌面工具，用来管理 AI 编码 Agent 的**提示词**和**技能库**。

它把提示词、技能库、客户端三者解耦：任意提示词可以搭配任意技能库，投放到任意客户端。想换一套组合，界面上点一下就行，不需要手动翻目录、复制粘贴文件。

**它不限定客户端。** 内置了常见 Agent 的预设，同时允许你自行指定放置路径 —— 选一个提示词文件、选一个技能文件夹、选一个目标文件夹，就接入了一个新客户端。

整个运行时（含内置的便携式 Codex）随包分发，拷到任意 Windows 机器上直接可用：不写注册表、不污染系统环境、卸载就是删文件夹。

### 核心能力

| 能力 | 说明 |
|---|---|
| **提示词管理** | 提示词以真实文件落盘，界面直接读磁盘；既可引用内置素材库，也可指向任意本地文件 |
| **技能库管理** | 技能以「包」为单位管理，安装时同步到目标客户端技能目录；自动识别 `simple` / `tree` / `router` 三种形态，整树复制以保住子技能与相对引用 |
| **自由搭配** | 提示词 × 技能库 × 客户端 任意组合。一个组合 = 一份 `manifest.json`；加一套 = 加一个目录，删一套 = 删一个目录，全程不改代码 |
| **客户端无限制** | 内置常见 Agent 预设，更支持自定义：指定「提示词文件 + 技能文件夹 + 目标文件夹」即可接入任意客户端 |
| **内置便携式 Codex** | 随包分发 Codex 运行时与官方桌面端，开箱即用，不需要系统预装 |
| **环境隔离** | 启动子进程时重定向 `CODEX_HOME` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `PATH`，不碰真实用户配置 |
| **路径自适应** | 按 环境变量 → 分发形态 → 资源目录 → 开发兜底 逐级探测，不写死盘符，换机器不用改配置 |
| **幂等写入** | 标记块替换语义：只替换工具自己写入的那一段，你手写的配置永远原样保留；首次改动前自动备份 |

### 内置运行时：便携式 Codex

| 点 | 说明 |
|---|---|
| 随包分发 | 运行时、依赖、私有 `APPDATA` / `TEMP` 全部在包内，不往系统里装东西 |
| 随机实例名 | 每次启动生成随机进程镜像名（硬链接实现，与本体共享同一份数据，**不额外占磁盘**），界面显示当前实例名，多实例互不混淆 |
| 自动回收 | 进程创建时即挂入 Job Object，主程序退出时由内核回收整棵进程树，不留残留进程 |
| 一键自检 | 面板内置自检，直接跑 `codex doctor` 并展示通过项与诊断明细 |
| 双形态 | CLI（独立控制台 TUI）与官方桌面端，各自独立配置目录，与系统已装版本互不干扰 |

### 支持的客户端

| 客户端 | 写入模式 |
|---|---|
| Codex | 标记块替换 |
| DSH | 标记块替换 |
| Claude | 四分支处理（换块内 / 整份 / 残留留证 / 追加） |
| Cursor | 整份覆盖（先备份） |
| ZCode | 整份覆盖（先备份） |
| WorkBuddy | 整份覆盖（先备份） |
| **自定义** | 自选「提示词文件 + 技能文件夹 + 目标文件夹」，接入任意客户端 |

### 界面

Tauri 原生外壳 + React 单页界面。提示词列表、技能库、版本清单、运行时控制、自检结果、实时日志都在同一屏里完成，状态直接可见，不用去翻日志文件。

### 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Tauri 2 + Rust |
| 界面 | React 19 + TypeScript 5.7 |
| 构建 | Vite 6 |
| 图标 | lucide-react |
| 扩展机制 | MCP（stdio） |

### 构建

```bash
npm install
npm run desktop      # 开发
npm run release      # 生产构建
```

> 生产构建必须显式带上 `--features custom-protocol`，否则二进制会去加载 dev 服务器地址，表现为「127.0.0.1 拒绝连接」。

### 项目状态

**开发中，尚未发布。** 目前只有本地可运行的构建产物，接口、清单格式与目录结构都可能变动。

### 许可

[MIT](LICENSE)

---

## English

### What it is

New Alice Assistant is a portable Windows desktop tool for managing the **prompts** and **skill libraries** of AI coding agents.

It decouples three things that are usually tangled together: prompts, skill packs, and clients. Any prompt can be paired with any skill pack and deployed to any client. Switching a combination takes one click in the UI — no manual directory browsing, no copy-pasting files.

**It does not restrict which client you use.** Common agents ship as built-in presets, and you can also point it at anything else yourself: pick a prompt file, pick a skill folder, pick a target folder — that client is now supported.

The whole runtime (including a bundled portable Codex) ships inside the package. Copy it to any Windows machine and it works as-is: no registry writes, no system pollution, and uninstalling means deleting the folder.

### Highlights

| Capability | Description |
|---|---|
| **Prompt management** | Prompts are real files on disk, read directly by the UI; reference the built-in asset library or any local file |
| **Skill library management** | Skills are managed as packs and synced into each client's skill directory; `simple` / `tree` / `router` layouts are detected automatically and copied as whole trees so sub-skills and relative references stay valid |
| **Free combination** | Prompt × skill pack × client, in any combination. One combination = one `manifest.json`; adding one = adding a directory, removing one = deleting a directory, with no code changes |
| **No client restrictions** | Built-in presets for common agents, plus custom setups: specify a prompt file, a skill folder, and a target folder to wire up any client |
| **Bundled portable Codex** | Codex runtime and the official desktop app ship in the package — works out of the box, no system install required |
| **Environment isolation** | Child processes get redirected `CODEX_HOME` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `PATH`; your real user configuration is never touched |
| **Path-agnostic** | Resolved by probing env var → bundle layout → resource dir → dev fallback. No hardcoded drive letters, no config edits when you move the folder |
| **Idempotent writes** | Marked-block replacement semantics: only the tool's own block is rewritten, your hand-written config is preserved, and a backup is taken before the first change |

### Bundled runtime: portable Codex

| Point | Description |
|---|---|
| Ships in the package | Runtime, dependencies, and private `APPDATA` / `TEMP` all live inside the bundle |
| Random instance name | Each launch creates a random process image name (via a hard link, so it shares the same data and **costs no extra disk space**); the UI shows the current instance name so multiple instances stay distinguishable |
| Automatic cleanup | The process is attached to a Job Object at creation, so the kernel reclaims the whole process tree when the main app exits — no leftovers |
| One-click self-check | Runs `codex doctor` and shows pass/fail items with expandable raw output |
| Two forms | CLI (standalone console TUI) and the official desktop app, each with its own config directory, isolated from any system-wide install |

### Supported clients

| Client | Write mode |
|---|---|
| Codex | Marked-block replacement |
| DSH | Marked-block replacement |
| Claude | Four-branch handling (replace block / whole file / keep evidence / append) |
| Cursor | Full overwrite (with backup) |
| ZCode | Full overwrite (with backup) |
| WorkBuddy | Full overwrite (with backup) |
| **Custom** | Your own prompt file + skill folder + target folder — any client |

### UI

A Tauri native shell with a React single-page interface. Prompt lists, skill libraries, version manifests, runtime control, self-check results, and live logs all live on one screen — state is visible directly instead of buried in log files.

### Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri 2 + Rust |
| UI | React 19 + TypeScript 5.7 |
| Bundler | Vite 6 |
| Icons | lucide-react |
| Extension mechanism | MCP (stdio) |

### Build

```bash
npm install
npm run desktop      # development
npm run release      # production build
```

> Production builds must explicitly enable `--features custom-protocol`, otherwise the binary loads the dev server URL and fails with "127.0.0.1 refused to connect".

### Status

**Work in progress, not released.** Only local build artifacts exist so far; APIs, manifest format, and directory layout may all change.

### License

[MIT](LICENSE)

---

<div align="center">
  <sub>MIT Licensed · Built with Tauri + Rust + React</sub>
</div>
