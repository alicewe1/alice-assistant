<div align="center">

# Alice Assistant

**Client manager for AI coding agents**

A portable desktop tool that decouples prompts, skill packs, and clients — combine them freely, deploy to any agent.

![status](https://img.shields.io/badge/status-work%20in%20progress-orange?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)
![license](https://img.shields.io/badge/license-GPL--3.0--or--later-185FA5?style=flat-square)

**English** · [简体中文](README.md)

</div>

---

### What it is

Alice Assistant is a portable Windows desktop tool for managing the **prompts** and **skill libraries** of AI coding agents.

It decouples three things that are usually tangled together: prompts, skill packs, and clients. Any prompt can be paired with any skill pack and deployed to any client. Switching a combination takes one click in the UI — no manual directory browsing, no copy-pasting files.

**It does not restrict which client you use.** Common agents ship as built-in presets, and you can also point it at anything else yourself: pick a prompt file, pick a skill folder, pick a target folder — that client is now supported.

The whole runtime (including a bundled portable Codex) ships inside the package. Copy it to any Windows machine and it works as-is: no registry writes, no system pollution, and uninstalling means deleting the folder.

---

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
| **Whole-file takeover** | One uniform rule for every client: the existing file is renamed to `-bak` first, then the rendered content is written in full. Reinstalling never accumulates, and uninstalling means deleting the file and restoring the `-bak` |

---

### Bundled runtime: portable Codex

| Point | Description |
|---|---|
| Ships in the package | Runtime, dependencies, and private `APPDATA` / `TEMP` all live inside the bundle |
| Random instance name | Each launch creates a random process image name (via a hard link, so it shares the same data and **costs no extra disk space**); the UI shows the current instance name so multiple instances stay distinguishable |
| Automatic cleanup | The process is attached to a Job Object at creation, so the kernel reclaims the whole process tree when the main app exits — no leftovers |
| One-click self-check | Runs `codex doctor` and shows pass/fail items with expandable raw output |
| Two forms | CLI (standalone console TUI) and the official desktop app, each with its own config directory, isolated from any system-wide install |

---

### Supported clients

Write semantics are **uniform** across all clients: whole-file takeover — the existing file is renamed to `-bak`, then the rendered content is written in full. There is no per-client write mode.

| Client | Injection target |
|---|---|
| Codex | `~/.codex/AGENTS.md` |
| DSH | `~/.dsh/AGENTS.md` |
| Claude | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/rules/<name>.mdc` |
| ZCode | `~/.zcode/AGENTS.md` |
| WorkBuddy | `~/.workbuddy-ai/AGENTS.md` |
| **Custom** | Your own prompt file + skill folder + target folder — any client |

---

### UI

A Tauri native shell with a React single-page interface. Prompt lists, skill libraries, version manifests, runtime control, self-check results, and live logs all live on one screen — state is visible directly instead of buried in log files.

---

### Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri 2 + Rust |
| UI | React 19 + TypeScript 5.7 |
| Bundler | Vite 6 |
| Icons | lucide-react |
| Extension mechanism | MCP (stdio) |

---

### Build

```bash
npm install
npm run desktop      # development
npm run release      # production build
```

> Production builds must explicitly enable `--features custom-protocol`, otherwise the binary loads the dev server URL and fails with "127.0.0.1 refused to connect".

---

### Status

**Work in progress, not released.** Only local build artifacts exist so far; APIs, manifest format, and directory layout may all change.

---

### License

Licensed under the **[GNU General Public License v3.0](LICENSE)** (GPL-3.0-or-later).

| You may | You must | You may not |
|---|---|---|
| Run the program for any purpose | Ship the license and copyright notice when distributing | Add extra restrictions to derivative works |
| Modify and build upon it | Indicate whether changes were made | Use technical measures to block permitted uses |
| Copy and redistribute | **License derivatives under the GPL and provide complete corresponding source** | Merge the program into proprietary software you redistribute |
| **Use it commercially** | Keep the original copyright and license notices | |

> **This IS an open source license.** GPL-3.0 is OSI-approved free software — **commercial use is permitted**. The obligation is **copyleft**: when you distribute a derivative work, it must also be licensed under the GPL, with complete source code.

> **Scope**: this license covers **only the parts originally created by alicewe1** — the application, the client presets, the original skill pack, and the documentation in this repository. The distribution bundles third-party components, each governed by its own license; see `THIRD-PARTY-NOTICES.md` inside the distribution for the full list and attribution requirements. Third-party licenses take precedence. In particular, the OpenAI Codex / ChatGPT desktop app is **proprietary and carries no redistribution right** — it must not be redistributed with this work without separate authorization. See [`NOTICE`](NOTICE) for the full statement.

**When referencing this project or building on it, keep this attribution:**

```
Alice Assistant — https://github.com/alicewe1/alice-assistant
Copyright (C) 2026 alicewe1 — Licensed under GNU GPL v3.0 or later
```

---

<div align="center">

**English** · [简体中文](README.md)

</div>
