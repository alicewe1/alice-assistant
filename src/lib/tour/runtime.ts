import type { TourStep } from './types'
import { anchorOf, clickAnchor } from './index'

/**
 * 「Alice-codex」页新手教程。
 *
 * 主线：先讲清「这是什么页」（随包分发的 codex 运行时，跟「会话」页的内置
 * Agent 不是一回事）→ 学会用「一键自检」判断装没装对 → 看体检面板与包内
 * 缺失时的导入入口 → 明白环境隔离（讲清这个用户才敢折腾）→ 启动/停止 →
 * 随机进程名 → 技能库 → 日志 → 配置透传与编辑器 → 收尾串主线。
 *
 * 顺序按用户的实际动手顺序排，不按界面从左到右读：先建立心智模型，再教动作。
 *
 * ══ 抽屉（config.toml 编辑器）的开合节奏 ═════════════════════════════
 * 编辑器是右侧全屏遮罩浮层（`runtime.config`，z-index 120），会盖住体检行
 * 里的「透传本机」按钮，所以讲「透传」那步之前必须先确保它是关的，
 * 讲「编辑器」那步再把它打开，最后收尾步收掉 —— 全程只开合一次。
 *
 * 关抽屉一律走 closeConfigDrawerIfClean()：它先确认「未保存」徽标不在场，
 * 干净才点关闭。教程期间 `.tour-layer` 吞掉全部点击，用户碰不到输入框，
 * 所以正常情况下必然是干净的；这道判断只是防止用户在教程开始前就已经
 * 改过内容 —— 那种情况宁可不关，也绝不在教程里弹确认框。
 *
 * 锚点全部来自本页元素的 `data-tour`。第 1 步与最后一步故意不带锚点 ——
 * 讲的是「整页是什么」「主线怎么串」，没有对应的单个元素，居中卡片最合适。
 */

/**
 * 打开包内 config.toml 抽屉（EDIT / config.toml 面板）。
 *
 * 为什么需要它：编辑器是抽屉，不点「编辑」按钮它根本不在 DOM 里，
 * 那一步就只能退化成居中卡片 —— 而这一页最该被看见的恰恰是它。
 *
 * 安全性：这一步只做「读文件 + 展开抽屉」，**不写任何东西**（写盘要另外
 * 点抽屉里的「保存」，教程全程不碰它）。已经开着就直接返回，不重复点。
 */
function openConfigDrawer(): void {
  if (anchorOf('runtime.config')) return
  clickAnchor('runtime.config-edit')
}

/**
 * 收起 config.toml 抽屉（只有确认干净时才收）。
 *
 * 为什么需要它：不收起，后面的步骤要么被遮罩挡住指不清，要么收尾卡片背后
 * 压着一个开着的大编辑器。
 *
 * 安全性（两道保险，因为抽屉一旦 dirty，关闭会弹「放弃未保存修改」确认框）：
 *   1. 教程期间 `.tour-layer` 覆盖全屏并吞掉所有点击，用户根本碰不到输入框，
 *      所以抽屉必然是干净的；
 *   2. 即便如此，这里仍然先探一次「未保存」徽标（`runtime.config-dirty` 只在
 *      dirty 时渲染）。徽标在就**什么都不做** —— 宁可留着抽屉让用户自己处理，
 *      也绝不在教程里弹确认框。
 */
function closeConfigDrawerIfClean(): void {
  if (!anchorOf('runtime.config')) return
  if (anchorOf('runtime.config-dirty')) return
  clickAnchor('runtime.config-close')
}

export const RUNTIME_TOUR: TourStep[] = [
  {
    title: '这是外部 codex 的管理台',
    body:
      '「会话」页聊的是站内内置 Agent；这一页启动的是真跑在你这台机器上的 codex 进程（CLI 或桌面端），模型、供应商、技能都取自随包分发的目录。两套体系互不影响，各用各的。',
  },
  {
    anchor: 'runtime.actions',
    placement: 'bottom',
    title: '一键自检：装没装对一看便知',
    body:
      '点它重跑一遍全部路径检查，几秒出结果。拿到新包、换电脑、或者 codex 起不来，第一步都先点这里 —— 没过的项会直接指出是哪条路径有问题，不用自己猜。',
  },
  {
    anchor: 'runtime.checks',
    placement: 'right',
    title: '体检面板：一行一个真实路径',
    body:
      '五行分别是 config.toml、codex 运行时、桌面端完整性、技能库、提示词库。绿勾 = 在，灰圈 = 缺。缺了先看该行提示，多数能就地补（编辑配置、透传本机、导入提示词），补完再自检一次。',
  },
  {
    /**
     * 故意不带锚点。
     *
     * 「IMPORT / 便携箱导入」面板只在体检项「配置文件 config.toml」没过
     * （包内没有 .codex）时才渲染 —— 它挂在条件分支上，而能让它出现的动作
     * 只有「选目录导入」，那是整目录文件复制，属于 `before` 明令不能碰的
     * 操作。所以这一步老老实实走居中卡片，把后果讲清楚就够。
     */
    title: '包内缺便携箱时怎么补',
    body:
      '包内没有 .codex 时，「运行体检」面板顶部会多出一块「便携箱导入」，别忽略它。选一个本机现成的 codex 目录（须含 config.toml）整目录复制进包里 —— 会话、记忆会被清空，配置和技能保留。',
  },
  {
    anchor: 'runtime.root',
    placement: 'right',
    title: '包根：整套环境关在包里',
    body:
      '启动时 CODEX_HOME、APPDATA、LOCALAPPDATA、TEMP 全部重定向到包内 data\\ 目录：不碰你本机那份 codex 配置，拷到别的电脑照样能用，随便折腾也不影响本机。',
  },
  {
    anchor: 'runtime.launch',
    placement: 'right',
    title: '启动与停止都在这组按钮',
    body:
      '「启动 CLI」开独立控制台，适合手敲命令；「启动桌面端」起 GUI，走独立 profile，不跟本机那份打架。停止走 taskkill /T /F 终止整棵进程树；下面那排是换随机名、强制清理残留与清理数据。',
  },
  {
    anchor: 'runtime.mask',
    placement: 'right',
    title: '随机进程名：扫进程的认不出',
    body:
      '每次启动都在运行体目录建一个随机名硬链接再拉起，任务管理器里显示的就是这个名字（如 wz7f3a91c2.exe），按 codex.exe 扫进程的工具直接漏掉。名字被盯上了就点上面的「换随机名重启」，换个新名字继续跑。',
  },
  {
    anchor: 'runtime.box',
    placement: 'left',
    title: '便携箱技能库：codex 只读这里',
    body:
      '面板上的技能数就是包内 .codex\\skills 里真正装着的数量，codex 启动时只从这里读 —— 这里几个，运行时就有几个。「选文件夹导入」是纯复制语义，同名先备份；移除只删包内这份，软件库不受影响。',
  },
  {
    anchor: 'runtime.log',
    placement: 'left',
    title: '运行日志：出问题先看这里',
    body:
      'codex 的 stdout/stderr 逐行推到这个面板，启动、自检、提示词注入的动作也都写在这里。启动失败的原因、进程 PID、任务跑飞时的报错都落在最后几行 —— 排障第一步永远先扫这里。',
  },
  {
    anchor: 'runtime.config-host',
    placement: 'right',
    // 抽屉会盖住这行按钮 —— 先确保它是关的（干净才关，见函数注释）
    before: closeConfigDrawerIfClean,
    title: '透传本机：搬本机的模型设置',
    body:
      '把这台机器 ~/.codex/config.toml 的模型与供应商字段搬进包内，只同步白名单字段，包内 MCP 段原样保留，不会把本机绝对路径带进来；原文件先备份。按钮置灰 = 本机没有这份配置。',
  },
  {
    anchor: 'runtime.config',
    placement: 'left',
    before: openConfigDrawer,
    title: '配置编辑器：模型与供应商在这',
    body:
      'model、model_provider、base_url 这些决定用哪个模型、走哪条中转的字段全在这个文件里。改完点「保存」，原文件自动备份成 .bak-edit-*，重启 codex 才生效 —— 所以随时能改回来。',
  },
  {
    // 收尾步顺便把上一步打开的抽屉收掉（干净才关，见函数注释）
    before: closeConfigDrawerIfClean,
    title: '主线：自检 → 启动 → 看日志',
    body:
      '装完包先「一键自检」，全绿再启动；起不来或者跑飞了，就去右栏运行日志看最后几行。这一页想重看，随时点右上角「使用教程」。',
  },
]
