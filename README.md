<div align="center">

# Alice 助手

**Agent 客户端管理助手**

便携式桌面工具：把提示词、技能库、客户端三者解耦，任意搭配，投放到任意 Agent。

![status](https://img.shields.io/badge/status-work%20in%20progress-orange?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![react](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![license](https://img.shields.io/badge/license-GPL--3.0--or--later-185FA5?style=flat-square)

[English](README.en.md) · **简体中文**

</div>

---

## 这是什么

Alice 助手是一个面向 Windows 的便携式桌面工具，用来管理 AI 编码 Agent 的**提示词**和**技能库**。

它把提示词、技能库、客户端三者解耦：任意提示词可以搭配任意技能库，投放到任意客户端。想换一套组合，界面上点一下就行，不需要手动翻目录、复制粘贴文件。

**它不限定客户端。** 内置了常见 Agent 的预设，同时允许你自行指定放置路径 —— 选一个提示词文件、选一个技能文件夹、选一个目标文件夹，就接入了一个新客户端。

整个运行时（含内置的便携式 Codex）随包分发，拷到任意 Windows 机器上直接可用：不写注册表、不污染系统环境、卸载就是删文件夹。

---

## 界面

<div align="center">

![总览](docs/screenshots/overview.jpg)

*总览 —— 客户端接入状态一屏看全*

</div>

<div align="center">

![目标](docs/screenshots/targets.jpg)

*目标 —— 选客户端 → 选预设组 → 确认提示词与技能 → 一键注入*

</div>

每个页面右上角有**使用教程**：点开后整屏压暗、当前该看的元素被挖孔高亮，旁边气泡讲解这一步在做什么，逐步走完一个页面。下面是教程第 1 步的效果：

<div align="center">

![新手教程](docs/screenshots/tour.jpg)

*新手教程 —— 挖孔高亮 + 指示箭头 + 分步讲解，支持跳过 / 上一步 / 下一步*

</div>

---

## 核心能力

| 能力 | 说明 |
|---|---|
| **提示词管理** | 提示词以真实文件落盘，界面直接读磁盘；既可引用内置素材库，也可指向任意本地文件 |
| **技能库管理** | 技能以「包」为单位管理，安装时同步到目标客户端技能目录；自动识别 `simple` / `tree` / `router` 三种形态，整树复制以保住子技能与相对引用 |
| **自由搭配** | 提示词 × 技能库 × 客户端 任意组合。一个组合 = 一份 `manifest.json`；加一套 = 加一个目录，删一套 = 删一个目录，全程不改代码 |
| **客户端无限制** | 内置常见 Agent 预设，更支持自定义：指定「提示词文件 + 技能文件夹 + 目标文件夹」即可接入任意客户端 |
| **内置便携式 Codex** | 随包分发 Codex 运行时，开箱即用，不需要系统预装 |
| **环境隔离** | 启动子进程时重定向 `CODEX_HOME` / `APPDATA` / `LOCALAPPDATA` / `TEMP` / `PATH`，不碰真实用户配置 |
| **路径自适应** | 按 环境变量 → 分发形态 → 资源目录 → 开发兜底 逐级探测，不写死盘符，换机器不用改配置 |
| **新手教程** | 每个功能页内置分步指引，高亮当前该操作的元素并说明用途，可随时跳过或重看 |
| **整份接管写入** | 所有客户端统一：目标文件先改名为 `-bak` 保留原件，再整份写入渲染结果。重复安装不会叠加，卸载 = 删文件 + 还原 `-bak` |

---

## 内置运行时：便携式 Codex

| 点 | 说明 |
|---|---|
| 随包分发 | 运行时、依赖、私有 `APPDATA` / `TEMP` 全部在包内，不往系统里装东西 |
| 随机实例名 | 每次启动生成随机进程镜像名（硬链接实现，与本体共享同一份数据，**不额外占磁盘**），界面显示当前实例名，多实例互不混淆 |
| 自动回收 | 进程创建时即挂入 Job Object，主程序退出时由内核回收整棵进程树，不留残留进程 |
| 一键自检 | 面板内置自检，逐项检查路径与运行时完整性，直接展示通过项与诊断明细 |
| 双形态 | CLI（独立控制台 TUI）与桌面端，各自独立配置目录，与系统已装版本互不干扰 |

---

## 支持的客户端

写入语义对所有客户端**统一**：整份接管 —— 原文件先改名为 `-bak`，再把渲染好的内容整份写进去。不存在按客户端区分写入模式的情况。

| 客户端 | 注入目标 |
|---|---|
| Codex | `~/.codex/AGENTS.md` |
| DSH | `~/.dsh/AGENTS.md` |
| Claude | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/rules/<名称>.mdc` |
| ZCode | `~/.zcode/AGENTS.md` |
| WorkBuddy | `~/.workbuddy-ai/AGENTS.md` |
| **自定义** | 自选「提示词文件 + 技能文件夹 + 目标文件夹」，接入任意客户端 |

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Tauri 2 + Rust |
| 界面 | React 19 + TypeScript 5.7 |
| 构建 | Vite 6 |
| 图标 | lucide-react |
| 扩展机制 | MCP（stdio） |

Tauri 原生外壳 + React 单页界面。提示词列表、技能库、版本清单、运行时控制、自检结果、实时日志都在同一屏里完成，状态直接可见，不用去翻日志文件。

---

## 从源码构建

前置：Node 18+、Rust stable、**MSVC 工具链**（VS Build Tools 的 VCTools 工作负载）、WebView2 Runtime（Win11 自带）。

```bash
npm install

npm run desktop        # 开发模式（Tauri dev）
npm run check          # 仅类型检查
npm run release        # 生产构建：tsc + vite + cargo release
```

生产构建必须显式带上 `--features custom-protocol`，否则 tauri 的 `build.rs` 会判定为 dev 模式：二进制去加载 `devUrl` 而不内嵌前端资源，运行表现为「嗯…无法访问此页面 / 127.0.0.1 拒绝连接」。

```bash
cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml
```

### 仓库结构

```
alice-ui/
├── src/                    前端（React + TS）
│   ├── components/         通用组件（含 tour.tsx 教程引擎）
│   ├── lib/                store / 后端调用封装 / 教程步骤表
│   ├── pages/              九个功能页
│   └── styles/             设计系统 tokens.css
├── src-tauri/              后端（Rust）
│   ├── src/                inject / profiles / runtime / cloud / alias …
│   └── capabilities/       Tauri 权限清单
└── docs/screenshots/       README 配图
```

---

## 项目状态

**开发中，尚未发布。** 接口、清单格式与目录结构都可能变动。

---

## 许可

本项目采用 **[GNU 通用公共许可协议第 3 版](LICENSE)**（GPL-3.0-or-later）许可。

| 你可以 | 你必须 | 你不可以 |
|---|---|---|
| 以任何目的运行本程序 | 分发时附上许可协议与版权声明 | 对衍生作品附加额外限制 |
| 修改、二次创作 | 标明是否作出了修改 | 用技术手段阻止他人行使许可权利 |
| 复制、分发 | **衍生作品必须同样以 GPL 授权，并提供完整对应源码** | 将本程序并入闭源专有软件再分发 |
| **用于商业目的** | 保留原有的版权与许可声明 | |

> **这是开源许可。** GPL-3.0 通过 OSI 认证，属于自由软件许可 —— **商业使用是被允许的**。它的约束在于**传染性（copyleft）**：把衍生作品分发出去时，必须同样以 GPL 授权并提供完整源码。

> **适用范围**：本许可**仅覆盖 alicewe1 原创的部分** —— 主程序、客户端预设、原创技能包与仓库内文档。分发包内含第三方组件，各自受其自身许可约束，相关清单与署名要求见分发包内的 `THIRD-PARTY-NOTICES.md`；第三方许可优先于本许可。完整声明见 [`NOTICE`](NOTICE)。

**引用本项目或做衍生作品时，请保留以下署名：**

```
Alice 助手 / Alice Assistant — https://github.com/alicewe1/alice-assistant
Copyright (C) 2026 alicewe1 — Licensed under GNU GPL v3.0 or later
```

---

<div align="center">

[English](README.en.md) · **简体中文**

</div>
