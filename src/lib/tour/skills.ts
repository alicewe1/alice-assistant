import type { TourStep } from './types'
import { anchorOf, clickAnchor } from './index'

/**
 * 「技能库」页新手教程。
 *
 * ══ 主线 ══════════════════════════════════════════════════════════════
 * 这一页是**素材仓库**：技能包放在这里，勾选状态跨页共享 —— 「目标」页安装时
 * 按这里的勾选生成实际要装的技能清单。所以整套教程的重点不是「怎么点按钮」，
 * 而是让用户明白**勾选 = 装不装**这条因果链，否则用户会以为这页只是看看而已。
 *
 * 步骤顺序按真实干活顺序：选包 → 看技能 → 找技能 → 勾/去勾 → 导入新技能 →
 * 看包信息与形态 → 改 SKILL.md，最后收尾点出与「目标」页的关系。
 * 不按界面从左到右讲，因为那样会把「选包」和「勾技能」拆散，因果断了。
 *
 * ══ 锚点为什么能直接用 ═══════════════════════════════════════════════
 * 本页进页面即自动选中第一个技能包（skills.tsx 的 useEffect），所以中列
 * 技能列表、搜索框、全选、导入按钮、右栏信息**初始就存在** —— 不像
 * 「目标」页那样需要 before 先点开预设组。只有 `skills.skill-first` /
 * `skills.skill-edit` 依赖「当前包里有技能」，空包时会退化成居中卡片，
 * 用 ensurePack() 兜一层。
 */

/**
 * 保证中列技能列表在场。
 *
 * 本页初始会自动选中第一个包，所以正常情况下这里什么都不用做。
 * 兜底场景：用户自己把包删光、或后端还没返回包列表 —— 此时中列是空状态。
 * 有 `skills.list` 就说明包已选中，直接返回；没有才点第一行。
 * 全是安全操作（只改选中项），不导入、不删除。
 */
function ensurePack(): void {
  if (anchorOf('skills.list')) return
  clickAnchor('skills.pack-first')
}

export const SKILLS_TOUR: TourStep[] = [
  {
    anchor: 'nav.pages',
    placement: 'bottom',
    title: '技能库：素材都在这',
    body:
      '顶栏第 03 项。技能包统一存在这里，是给「目标」页安装时取用的仓库。这一页只管备料和勾选，真正写进客户端要在「目标」页点安装。',
  },
  {
    anchor: 'skills.packs',
    placement: 'right',
    title: '左侧：技能包列表',
    body:
      '一个技能包 = 一整套技能集合（比如 Alice-skills）。点一行切换，中列和右栏会立刻刷成这个包的内容。行内铅笔改名、垃圾桶删整包 —— 删包会连同里面的技能一起删掉。',
  },
  {
    anchor: 'skills.list',
    placement: 'right',
    before: ensurePack,
    title: '中间：这个包里的技能',
    body:
      '列出磁盘上真实的技能目录，标题右边标着形态与文件数。每个技能都有开关、打开目录、编辑 SKILL.md、删除四个操作。带黄色警告图标的是格式不合规的技能（缺 name/description）。',
  },
  {
    anchor: 'skills.skill-first',
    placement: 'right',
    before: ensurePack,
    title: '开关：勾上 = 会被安装',
    body:
      '这一行的开关是本页最关键的控件。勾选状态跨页共享 —— 「目标」页安装时按它生成实际要装的技能清单，取消勾选就是**这个技能不装**。中列顶部的「已勾选 N/M」实时反映数量。',
  },
  {
    anchor: 'skills.search',
    placement: 'bottom',
    title: '技能多了就搜',
    body:
      '按技能名或描述过滤中列列表。只影响显示，不会改变任何勾选状态 —— 放心搜，搜完勾选还在。',
  },
  {
    anchor: 'skills.select-all',
    placement: 'bottom',
    title: '全选 / 全不选',
    body:
      '一键勾上或清空**当前这个包**的全部技能。通常配合搜索用：先搜一个关键词、再全选，比一个个点快得多。旁边还能直接打开技能包目录。',
  },
  {
    anchor: 'skills.import',
    placement: 'bottom',
    title: '往包里加技能',
    body:
      '「选文件夹」从资源管理器挑一个技能目录；「选压缩包」直接多选 .zip，会自动解压并识别里面的技能。两种方式都会做重名与格式检查，导入结果在弹窗里逐条列给你看。',
  },
  {
    anchor: 'skills.info',
    placement: 'left',
    title: '右栏：这个包的底细',
    body:
      '包名、显示名、技能数、以及它在磁盘上的真实目录。改完包内容对不上时，先来这里核对目录对不对。「打开目录」直接把资源管理器开到这个包。',
  },
  {
    anchor: 'skills.shapes',
    placement: 'left',
    title: '技能形态：三种结构',
    body:
      '单文件 = 只有 SKILL.md；参考树 = 带 references/；路由型 = 带 subskills/ 子技能。形态决定复制方式：路由型必须整棵目录树一起搬，只拿 SKILL.md 会打断它的子路由引用。',
  },
  {
    anchor: 'skills.skill-edit',
    placement: 'right',
    before: ensurePack,
    title: '直接改 SKILL.md 正文',
    body:
      '点铅笔打开抽屉编辑器，改这个技能的 SKILL.md。改完必须点抽屉里的「保存」才落盘 —— 有未保存改动时标题旁会亮「未保存」标签。',
  },
  {
    title: '技能库主线：备料 → 勾选 → 去安装',
    body:
      '在这里把技能准备好、勾上要用的，然后回「目标」页选中预设组点安装，勾选的技能就会真的装进客户端。随时点右上「使用教程」重看这一页。',
  },
]
