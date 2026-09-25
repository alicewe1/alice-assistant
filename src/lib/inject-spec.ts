// 注入规格 — 逐条对齐旧版 install*.ps1（三个来源交叉验证，非推测）
//
// 提取来源：旧 Electron 包的 resources/install*.ps1（共 3884 行，全文精读）
//          + 旧包 app.asar 内的 main.cjs L215-287（版本表与参数拼装）
//
// ── 各客户端的真实写入语义（差异极大，必须分开处理）────────────────
//
//  Codex   : AGENTS.md 用**中文标记块**「寒霜破甲注入开始 · <文件名>」…
//            已存在→只换块内；空或等于已知提示词→整份替换；用户内容→追加+备份
//            提示词另存 <CodexHome>\managed-prompts\<名>；config.toml 写 model_instructions_file
//            技能 → <CodexHome>\skills；模块 → skills\_modules
//
//  ZCode   : AGENTS.md **整份覆盖**（无标记块、无幂等）
//            记忆 → cli\memories\global\memory\seagull-agents.md + 去重更新 MEMORY.md
//            技能 → <ZcodeHome>\skills
//
//  Cursor  : 全局 User Rules 写 .mdc（YAML frontmatter + alwaysApply: true）
//            **整份覆盖**；仅当撞名的用户自建规则才备份 .bak
//            技能 → ~/.l-skill/skills；模块 → ~/.l-skill/modules
//
//  Claude  : CLAUDE.md **四分支**：有块→换块内；空/纯提示词→整份；
//            无标记但是提示词（老版残渣）→挪走留证 inject-<ts>；用户内容→首次备份+追加
//            固定备份 managed-prompts\CLAUDE.md.bak；技能 → ~/.claude/skills
//
//  WorkBuddy: **不写 AGENTS.md**！提示词进云记忆档案 memory\<uid>_memory.md 的
//            Memory Block + <ConfigDir>\MEMORY.md + app-config.json 开关
//            技能 → <ConfigDir>\skills（sha256 清单 .hanshuang-skills.json）
//
//  DSH     : AGENTS.md **整份覆盖** + HANSHUANG-INJECT 标记（懒人包带 pack= 载荷）
//            懒人包另写 shield-protocol.md、prompt-inject.md、dsh-prompt-inject.json
//            技能 → <DshHome>\skills；competition-*/eni-redteam-*-detail-pack 移入 skills-disabled
//
// ── 全局不变量 ──────────────────────────────────────────────
//  • UTF-8 **无 BOM**（旧版显式 UTF8Encoding($false)）
//  • 提示词正文归一为 **LF**；块边界与配置文件用 CRLF
//  • 模板 {{CHANNEL}}/{{CHANNEL_LABEL}}/{{SKILLS_ROOT}}/{{MODULES_ROOT}} 注入时展开，反斜杠→正斜杠
//  • 渲染残留 {{...}} 直接报错（Assert-HsRendered）
//  • 剥离头部元数据注释（L-SKILL-VERSION|CONTRACT|SKILLS-ROOT…），**保留** MANAGED-PERSONA 与握手块
//  • 技能只收录含 SKILL.md 的一级子目录
//  • 时间戳备份保留最近 3 份；固定名备份 = 唯一原件，永不清理
//  • 卸载只删「state 清单 ∩ 随包技能库」里的技能，用户自建的一律不动

import type { ClientSpec } from '@/types/inject'

/** 顶尖破甲 V5 的二级选择（双击提示词，均不装技能） */
const ASTRA_CHOICES = [
  { name: '六 · GPT-6 Astra', desc: 'Astra 事务提交规范 · 适合 GPT-6.0', file: 'gpt-6-astra-v1.md' },
  {
    name: '5.6 · GPT-5.6 Sol',
    desc: 'Sol 无限制执行规范 · 适合 GPT-5.6',
    file: 'gpt-5.6-sol-unrestricted-v45.md',
  },
]

/** 标记串常量（与 Rust 侧一致） */
const MARK_CN_BEGIN = '寒霜破甲注入开始'
const MARK_CN_END = '寒霜破甲注入结束'
const MARK_HS_BEGIN = 'HANSHUANG-INJECT:BEGIN'
const MARK_HS_END = 'HANSHUANG-INJECT:END'
const MARK_CURSOR = 'HANSHUANG-CURSOR-INJECT'

export const CLIENT_SPECS: ClientSpec[] = [
  // ==================== Codex ====================
  {
    id: 'codex',
    name: 'Codex 破甲',
    legacyScript: 'install.ps1',
    injectTargets: [
      {
        path: '~/.codex/AGENTS.md',
        mode: 'markedBlock',
        beginKey: MARK_CN_BEGIN,
        endKey: MARK_CN_END,
        beginPayload: ' · 寒霜v4.md',
        backupSuffix: '.bak-inject',
        stampTag: 'backup',
      },
    ],
    skillSync: [{ dest: '~/.codex/skills' }],
    moduleSync: '~/.codex/skills/_modules',
    versions: [
      {
        id: 'codex-v5',
        label: '顶尖破甲 V5',
        desc: 'GPT-6 Astra / GPT-5.6 Sol 双提示词 · 不装任何 skills',
        file: 'gpt-6-astra-v1.md',
        choices: ASTRA_CHOICES,
        recommended: true,
        skillPacks: [],
      },
      {
        id: 'codex-v4',
        label: '顶尖破甲 V4',
        desc: '最新规范 + 63 模块 V4 专属技能库',
        file: '寒霜v4.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'codex-v3',
        label: '顶尖破甲 V3',
        desc: '工作规范 · 硬拒绝场景覆盖 + 拒绝话术全清单',
        file: '寒霜v3.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'codex-v2',
        label: '顶尖破甲 V2',
        desc: '完整 CTF Lab 2.0 规范 · 身份路由 + 交付标准 + 压缩防护',
        file: '寒霜v1.2.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'codex-v1',
        label: '顶尖破甲 v1',
        desc: '旧版顶尖提示词 · 两阶段交付（英文版）',
        file: '寒霜-变体B-v3-英文.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'codex-pro',
        label: '破甲助手专业版v1',
        desc: '旧版 v5 提示词 + 专业版技能包（5 入口 + 166 模块）',
        file: '破甲助手专业版v1.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-pro-v1'],
      },
      {
        id: 'codex-v5lib',
        label: '顶尖破甲 V5 + V5 技能库',
        desc: 'v5 提示词 + V5 技能库（426 目录 / 996 文件）',
        file: '寒霜v5.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v5'],
      },
    ],
  },

  // ==================== ZCode ====================
  {
    id: 'zcode',
    name: 'ZCode 破甲',
    legacyScript: 'install-zcode.ps1',
    injectTargets: [
      // ZCode 是整份覆盖，没有标记块
      {
        path: '~/.zcode/AGENTS.md',
        mode: 'overwrite',
        marker: 'CTF-LAB-2.0',
        backupSuffix: '.bak-inject',
        stampTag: 'backup',
      },
      // 记忆文件（YAML front-matter + 提示词全文）
      {
        path: '~/.zcode/cli/memories/global/memory/seagull-agents.md',
        mode: 'overwrite',
        backupSuffix: '.bak-inject',
      },
    ],
    skillSync: [{ dest: '~/.zcode/skills' }],
    moduleSync: '~/.zcode/skills/_modules',
    versions: [
      {
        id: 'zcode-v4',
        label: 'ZCode 破甲 V4',
        desc: '最新规范 → AGENTS.md + 全局记忆 + 系统提示词 + V4 技能库',
        file: '寒霜v4.md',
        choices: [],
        recommended: true,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'zcode-v3',
        label: 'ZCode 破甲 V3',
        desc: '工作规范 v3 → AGENTS.md + 全局记忆 + 系统提示词',
        file: '寒霜v3.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills'],
      },
      {
        id: 'zcode-v2',
        label: 'ZCode 破甲 V2',
        desc: 'CTF Lab 2.0 完整规范（海鸥版）',
        file: '寒霜v1.2.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills'],
      },
      {
        id: 'zcode-pro',
        label: '破甲助手专业版v1',
        desc: '旧版 v5 提示词 + 专业版技能包（166 模块）',
        file: '破甲助手专业版v1.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-pro-v1'],
      },
    ],
  },

  // ==================== Cursor ====================
  {
    id: 'cursor',
    name: 'Cursor 破甲',
    legacyScript: 'install-cursor.ps1',
    injectTargets: [
      {
        path: '~/.cursor/rules/寒霜注入.mdc',
        mode: 'overwrite',
        marker: MARK_CURSOR,
        frontmatter:
          '---\ndescription: 寒霜工作规范（自动注入 · 全局生效）\nglobs: "**/*"\nalwaysApply: true\n---',
        backupSuffix: '.bak',
      },
      // 旧版兼容
      {
        path: '~/.cursorrules',
        mode: 'overwrite',
        marker: MARK_CURSOR,
        backupSuffix: '.bak',
      },
    ],
    skillSync: [{ dest: '~/.l-skill/skills' }],
    moduleSync: '~/.l-skill/modules',
    versions: [
      {
        id: 'cursor-v4',
        label: 'Cursor 破甲 V4',
        desc: 'v4 规范注入 Cursor 全局规则（不装技能）',
        file: '寒霜v4.md',
        choices: [],
        recommended: true,
        skillPacks: [],
      },
      {
        id: 'cursor-v3',
        label: 'Cursor 破甲 V3',
        desc: 'v3 规范注入 Cursor 全局规则（不装技能）',
        file: '寒霜v3.md',
        choices: [],
        recommended: false,
        skillPacks: [],
      },
      {
        id: 'cursor-pro',
        label: '破甲助手专业版v1',
        desc: '旧版 v5 提示词注入 Cursor 全局规则 + 专业版技能包',
        file: '破甲助手专业版v1.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-pro-v1'],
      },
    ],
  },

  // ==================== Claude Code ====================
  {
    id: 'claude',
    name: 'Claude 破甲',
    legacyScript: 'install-claude.ps1',
    injectTargets: [
      {
        path: '~/.claude/CLAUDE.md',
        mode: 'claudeBlock',
        beginKey: MARK_HS_BEGIN,
        endKey: MARK_HS_END,
        beginPayload: ' prompt=寒霜v4-claude.md',
        fixedBackup: '~/.claude/managed-prompts/CLAUDE.md.bak',
        stampTag: 'inject',
      },
    ],
    skillSync: [{ dest: '~/.claude/skills' }],
    moduleSync: '~/.claude/skills/_modules',
    versions: [
      {
        id: 'claude-v4',
        label: 'Claude 破甲 V4',
        desc: '工作规范 v4（CLAUDE.md 版）· 自动安装 V4 专属技能',
        file: '寒霜v4-claude.md',
        choices: [],
        recommended: true,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'claude-v3',
        label: 'Claude 破甲 V3',
        desc: '工作规范 v3 · Claude Code 版（同样装 V4 技能库）',
        file: '寒霜v3.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'claude-pro',
        label: '破甲助手专业版v1',
        desc: '旧版 v5 提示词注入 ~/.claude/CLAUDE.md + 专业版技能包',
        file: '破甲助手专业版v1.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-pro-v1'],
      },
    ],
  },

  // ==================== WorkBuddy 国际版 ====================
  {
    id: 'workbuddy',
    name: 'WorkBuddy 破甲（国际版）',
    legacyScript: 'install-workbuddy.ps1',
    // 注意：WorkBuddy **不写 AGENTS.md**；提示词进云记忆档案 + MEMORY.md
    injectTargets: [
      {
        path: '~/.workbuddy-ai/memory/default_memory.md',
        mode: 'overwrite',
        backupSuffix: '.bak-inject',
      },
      {
        path: '~/.workbuddy-ai/MEMORY.md',
        mode: 'overwrite',
        backupSuffix: '.bak-inject',
      },
    ],
    skillSync: [{ dest: '~/.workbuddy-ai/skills' }],
    skillManifest: '~/.workbuddy-ai/skills/.hanshuang-skills.json',
    moduleSync: '~/.workbuddy-ai/skills/_modules',
    versions: [
      {
        id: 'workbuddy-v4',
        label: 'WorkBuddy 国际版 V4',
        desc: 'v4 → 云记忆 + MEMORY.md + 63 技能库',
        file: '寒霜v4.md',
        choices: [],
        recommended: true,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'workbuddy-v3',
        label: 'WorkBuddy 国际版 V3',
        desc: 'v3 → 云记忆 + MEMORY.md + 技能库',
        file: '寒霜v3.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills'],
      },
      {
        id: 'workbuddy-v2',
        label: 'WorkBuddy 国际版 V2 (海鸥)',
        desc: 'CTF Lab 2.0 海鸥版 → 云记忆 + MEMORY.md',
        file: '寒霜v1.2.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills'],
      },
      {
        id: 'workbuddy-pro',
        label: '破甲助手专业版v1',
        desc: '旧版 v5 提示词 → 云记忆 + MEMORY.md + 专业版技能包（166 模块）',
        file: '破甲助手专业版v1.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-pro-v1'],
      },
    ],
  },

  // ==================== DeepSeek Harness ====================
  {
    id: 'dsh',
    name: 'DeepSeek Harness 破甲',
    legacyScript: 'install-dsh.ps1',
    injectTargets: [
      {
        path: '~/.dsh/AGENTS.md',
        mode: 'markedBlock',
        beginKey: MARK_HS_BEGIN,
        endKey: MARK_HS_END,
        // 懒人包会带 pack= 载荷，非懒人包不带
        fixedBackup: '~/.dsh/managed-prompts/AGENTS.md.bak',
      },
    ],
    skillSync: [{ dest: '~/.dsh/skills' }],
    moduleSync: '~/.dsh/skills/_modules',
    versions: [
      {
        id: 'dsh-kit5',
        label: 'DSH 破甲懒人包 v5',
        desc: '人设 + 每轮重锁协议 + 150 技能包',
        file: 'operator-config-v5.md',
        choices: [],
        recommended: true,
        // 懒人包走 materials/skills + 附带 shield-protocol.md 等
        skillPacks: ['dsh-lazy-pack-v5'],
        extraFiles: ['shield-protocol.md', 'prompt-inject.md'],
      },
      {
        id: 'dsh-v4',
        label: 'DeepSeek Harness 破甲 V4',
        desc: '工作规范 v4（Claude Code 版）· 自动安装 V4 专属技能（63 模块）',
        file: '寒霜v4-claude.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'dsh-v3',
        label: 'DeepSeek Harness 破甲 V3',
        desc: '工作规范 v3 · Claude Code 版（同样装 V4 技能库）',
        file: '寒霜v3.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-v4'],
      },
      {
        id: 'dsh-pro',
        label: '破甲助手专业版v1',
        desc: '旧版 v5 提示词写入 ~/.dsh/AGENTS.md + 专业版技能包（166 模块）',
        file: '破甲助手专业版v1.md',
        choices: [],
        recommended: false,
        skillPacks: ['codex-skills-pro-v1'],
      },
    ],
  },
]

export function getClientSpec(id: string): ClientSpec | null {
  return CLIENT_SPECS.find((c) => c.id === id) ?? null
}

export function effectiveVersion(spec: ClientSpec, preferredId?: string | null) {
  if (preferredId) {
    const hit = spec.versions.find((v) => v.id === preferredId)
    if (hit) return hit
  }
  return spec.versions.find((v) => v.recommended) ?? spec.versions[0] ?? null
}
