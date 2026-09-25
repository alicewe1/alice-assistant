import type { TourStep } from './types'
import { anchorOf, clickAnchor } from './index'

/**
 * 「目标」页新手教程。
 *
 * 步骤顺序 = 用户的实际操作顺序：选客户端 → 选预设组 → 看提示词/技能 →
 * 点安装 → 回来看注入状态。不按界面从左到右讲，因为那样会把「安装」
 * 拆成三段，用户记不住主线。
 *
 * 锚点全部来自本页与 target-rail / topnav 上的 `data-tour`。
 * 中列「安装」面板只在选中预设组后才存在，所以下面用 ensureSelected()
 * 先把第一行点上 —— 用户第一次进这个页面很可能一个都没选。
 */

/**
 * 保证中列「安装」面板在场。
 *
 * 没选预设组时中列是「选择左侧版本」的空状态，提示词/技能/安装按钮
 * 三处锚点全都不存在，那几步会退化成居中卡片（能读，但没了高亮很干）。
 * 这里先把第一个预设组点开，让后续步骤有东西可指。
 */
function ensureSelected(): void {
  if (anchorOf('targets.install-btn')) return
  clickAnchor('targets.profile-first')
}

export const TARGETS_TOUR: TourStep[] = [
  {
    anchor: 'nav.pages',
    placement: 'bottom',
    title: '这里是全部功能区',
    body:
      '顶栏七项就是工具的全部入口：总览看状态，目标装配置，技能库/提示词准备素材，会话和 Alice-codex 用来跑，云过审管中转。点任意一项切换，当前页高亮。',
  },
  {
    anchor: 'rail.clients',
    placement: 'right',
    title: '先选一个客户端',
    body:
      '左栏列出已接入的客户端（Codex / ZCode / Cursor / Claude / WorkBuddy / DSH…）。点一行切换目标，右侧三个面板会立刻刷成它的配置。行内绿点 = 这个客户端已经注入过。',
  },
  {
    anchor: 'rail.add',
    placement: 'right',
    title: '接入一个新客户端',
    body:
      '点这里会新建 profiles/<客户端>/ 目录并写一份默认预设组。工作路径（比如 user/.xxx）可以在行内铅笔按钮里改，改完该客户端下所有预设组的落点会一起跟着变。',
  },
  {
    anchor: 'targets.profiles',
    placement: 'right',
    title: '预设组 = 提示词 + 技能库',
    body:
      '每个预设组是一套打包好的安装组合。点一行选中，中间的「安装」面板就显示它挂了哪份提示词、哪个技能库。铅笔改配置，垃圾桶删整组。',
  },
  {
    anchor: 'targets.prompt',
    placement: 'bottom',
    before: ensureSelected,
    title: '提示词：要注入的正文',
    body:
      '这是本组要写进客户端的提示词文件。右侧绿标「文件存在」表示磁盘上找得到；红标「找不到」就得去「提示词」页把这个文件补上，否则安装按钮点不动。一个组挂了多份提示词时，用上面的芯片多选一。',
  },
  {
    anchor: 'targets.skills',
    placement: 'bottom',
    before: ensureSelected,
    title: '技能库：要装的技能',
    body:
      '芯片就是本组挂的技能包，点一下可以临时取消勾选（不装这一包）。如果芯片旁出现「重名 N」，说明有同名技能，先点开「技能库」按钮决定取哪一份 —— 不定的话安装时会卡住让你选。',
  },
  {
    anchor: 'targets.install-btn',
    placement: 'top',
    before: ensureSelected,
    title: '点这里安装（注入）',
    body:
      '把提示词和技能真正写进客户端。注入前会自动备份原文件（原文件改名为 -bak），所以随时可以用上面红色的「卸载还原」一键恢复。下面那行小字就是这条承诺。',
  },
  {
    anchor: 'targets.points',
    placement: 'left',
    title: '注入位置：装到了哪里',
    body:
      '右栏列出本组的全部落点 —— 提示词写进哪个文件、技能装到哪个目录、有哪些第三方位置。绿点 = 已经落盘，灰点 = 还没装。右侧标签直接写明状态：已注入 / 已装技能 / 已放置 / 未安装。',
  },
  {
    anchor: 'targets.actions',
    placement: 'bottom',
    title: '顶部三个动作按钮',
    body:
      '「重新扫描」：你在磁盘上手动改了 profile 之后点它重读。「卸载还原」：注入过之后才出现，按备份把原文件还原回去。「新建预设组」：自己拼一套提示词 + 技能库的组合。',
  },
  {
    title: '目标页就这些',
    body:
      '记住这条主线就够了：选客户端 → 选预设组 → 确认提示词和技能 → 点安装。装完去「会话」页或直接启动 Alice-codex 就能用。随时可以点右上「使用教程」重看。',
  },
]
