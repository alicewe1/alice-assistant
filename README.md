<div align="center">

# 新 alice 助手

**便携式 AI 编码助手配置管理器**

*Portable profile & skill manager for AI coding clients*

![status](https://img.shields.io/badge/status-work%20in%20progress-orange?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-1D9E75?style=flat-square)

</div>

---

## 简体中文

### 这是什么

新 alice 助手是一个面向 Windows 的便携式桌面工具，用来集中管理 AI 编码助手的**配置、提示词与技能包**。

运行时、依赖、配置和私有数据全部收在一个文件夹里 —— 拷到任意一台 Windows 机器上直接可用，不写注册表、不污染系统环境、卸载就是删文件夹。

它解决的问题很具体：**同一套提示词和技能库，要在 Codex / ZCode / Cursor / Claude / WorkBuddy / DSH 之间反复重装。** 这里把「一个可安装版本」抽象成一份清单文件：安装 = 读清单 + 同步文件，加版本 = 加目录，删版本 = 删目录，全程不需要改代码。

### 核心特性

| 特性 | 说明 |
|---|---|
| **便携分发** | 运行时与私有 `APPDATA` / `TEMP` 全部重定向到包内目录，整个文件夹拷走即用 |
| **清单驱动** | 一个版本 = 一份 `manifest.json`，声明提示词来源、技能包、注入点与同步目标 |
| **多客户端** | 同一套素材按客户端差异分发，各客户端配置互不干扰 |
| **环境隔离** | 启动子进程时重定向 `CODEX_HOME` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `PATH` |
| **幂等注入** | 标记块替换语义：只替换工具自己写入的那一段，用户手写内容原样保留 |
| **无硬编码路径** | 按 环境变量 → 分发形态 → 资源目录 → 开发兜底 逐级探测，不写死盘符 |
| **技能形态自适应** | 自动识别 `simple` / `tree` / `router` 三种技能目录形态，整树复制以保住相对引用 |

### 支持的客户端

| 客户端 | 注入模式 |
|---|---|
| Codex | 标记块替换 |
| DSH | 标记块替换 |
| Claude | 四分支处理（换块内 / 整份 / 残留留证 / 追加） |
| Cursor | 整份覆盖（先备份） |
| ZCode | 整份覆盖（先备份） |
| WorkBuddy | 整份覆盖（先备份） |
| 自定义 | 指定提示词文件 + 技能文件夹 + 目标文件夹 |

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

New Alice Assistant is a portable Windows desktop tool for managing the **configuration, prompts, and skill packs** of AI coding assistants.

Runtime, dependencies, config, and private data all live inside a single folder. Copy it to any Windows machine and it works as-is: no registry writes, no system pollution, and uninstalling means deleting the folder.

It solves one concrete problem: **the same prompts and skill library have to be reinstalled over and over across Codex / ZCode / Cursor / Claude / WorkBuddy / DSH.** Here, one installable version is abstracted into a single manifest file. Installing means reading a manifest and syncing files; adding a version means adding a directory, removing one means deleting a directory — no code changes involved.

### Highlights

| Feature | Description |
|---|---|
| **Portable** | Runtime and private `APPDATA` / `TEMP` are redirected inside the bundle |
| **Manifest-driven** | One version = one `manifest.json`: prompt source, skill pack, inject targets, sync destinations |
| **Multi-client** | One set of assets distributed per client, with isolated configuration |
| **Environment isolation** | Child processes get redirected `CODEX_HOME` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `PATH` |
| **Idempotent injection** | Marked-block replacement — only the tool's own block is touched, user content is preserved |
| **No hardcoded paths** | Resolved by probing env var → bundle layout → resource dir → dev fallback |
| **Skill-shape aware** | Detects `simple` / `tree` / `router` layouts and copies whole trees to keep relative references valid |

### Supported clients

| Client | Injection mode |
|---|---|
| Codex | Marked-block replacement |
| DSH | Marked-block replacement |
| Claude | Four-branch handling (replace block / whole file / keep evidence / append) |
| Cursor | Full overwrite (with backup) |
| ZCode | Full overwrite (with backup) |
| WorkBuddy | Full overwrite (with backup) |
| Custom | Specify prompt file + skill folder + target folder |

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
