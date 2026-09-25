import type { TourStep } from './types'
import { anchorOf, clickAnchor } from './index'

/**
 * 「会话」页新手教程。
 *
 * ══ 主线 ══════════════════════════════════════════════════════════════
 * 一句话区别先说清（第 1 步）：这页是**工具内置**的 Agent 对话，独立提示词 +
 * 固定技能；顶栏 06「Alice-codex」是启动**外部** codex CLI / 桌面端。
 * 用户最容易把这两页混成一件事，所以开场就把它摁死，后面才好讲。
 *
 * 之后按真实操作顺序走：看历史列表 → 新建 → 选中一个 → 配置条（提示词 /
 * 固定技能 / 体检 / 快照）→ 对话区 → 输入框 → 收尾串主线。
 *
 * ══ 为什么几乎每步都要 before ═════════════════════════════════════════
 * 右栏是**整块条件渲染**的：没选中会话时只有一张「选择左侧会话」的空状态，
 * 配置条 / 对话区 / 输入框的锚点全都不存在，那几步会退化成居中卡片（话照样
 * 讲得完，但没了高亮很干）。所以从「选中会话」那步开始，每步都用
 * ensureSession() 兜一下：已经选中就什么都不做，没选中才点第一行。
 *
 * 全项目每个 data-tour 键必须唯一 —— 本文件用到的 `nav.pages` 来自
 * topnav.tsx，其余 `session.*` 都挂在 pages/session.tsx 上。
 */

/**
 * 保证右栏「会话 UI」在场。
 *
 * 已经选中会话时（`session.config` 找得到）直接返回，不去动用户当前的选中行；
 * 只有右栏还是空状态时才点一下第一个会话行。
 *
 * 会话列表为空、或第一次进页面还没扫出结果时，clickAnchor 找不到元素是
 * 安全的无操作 —— 后续锚点退化成居中卡片，教程不中断，这里不做额外判空。
 */
function ensureSession(): void {
  if (anchorOf('session.config')) return
  clickAnchor('session.row-first')
}

export const SESSION_TOUR: TourStep[] = [
  {
    anchor: 'nav.pages',
    placement: 'bottom',
    title: '工具内置的 Agent 对话页',
    body:
      '顶栏 05「会话」就是这里：工具自带的 Agent 对话，一个会话一套独立提示词，技能固定内置。旁边的 06「Alice-codex」是启动外部的 codex CLI / 桌面端，两页别混 —— 想在这聊就留在这。',
  },
  {
    anchor: 'session.list',
    placement: 'right',
    title: '历史会话：一行一套上下文',
    body:
      '左栏每行就是一个会话，各自有提示词、技能和聊天记录，互不影响。行内徽章说明技能挂上没有，下面小字是本会话已有几条消息、还能不能接着聊。',
  },
  {
    anchor: 'session.new',
    placement: 'bottom',
    title: '新建会话 = 开一套新上下文',
    body:
      '点它输入名字（这个名字同时是磁盘目录名），会生成 prompt.md、skills/ 和聊天记录。想换角色、或者换一件不相干的事做，就新建一个，别在旧会话里硬拗。',
  },
  {
    anchor: 'session.row-first',
    placement: 'right',
    // 右栏整块是条件渲染的：先点中第一行，后面的配置条 / 对话区 / 输入框才会出现。
    before: () => clickAnchor('session.row-first'),
    title: '点一行选中它，右栏才有内容',
    body:
      '选中后右边才会出现配置条、对话区和输入框；没选时右栏只有「选择左侧会话」。下面几步讲的都是你现在选中的这个会话。',
  },
  {
    anchor: 'session.config',
    placement: 'bottom',
    before: ensureSession,
    title: '配置条：这个会话的全部设置',
    body:
      '提示词、固定技能、体检、快照四项收纳成一行，给对话区腾地方。条上所有东西都只作用于当前选中的会话，切到别的会话就是另一套。',
  },
  {
    anchor: 'session.prompt-btn',
    placement: 'bottom',
    before: ensureSession,
    title: '提示词：每个会话各写一份',
    body:
      '点开是本会话 prompt.md 的编辑抽屉，保存后下一轮立即生效，原文件自动备份 .bak-edit-*。要让爱丽丝换角色、换口径就改这里，不会影响别的会话。',
  },
  {
    anchor: 'session.skill',
    placement: 'bottom',
    before: ensureSession,
    title: '固定技能：不可换的那一个',
    body:
      'alice_agent-skill 是内置写死的：负责启动自检、限定工作范围，不能换也不能卸。所以这页不给你挂技能 —— 要挂外部技能，去「目标」页装到客户端。',
  },
  {
    anchor: 'session.checks',
    placement: 'bottom',
    before: ensureSession,
    title: '体检徽章：N/M 项通过',
    body:
      '显示这次环境体检过了几项，全过才是干净环境。有失败项时配置条下方会展开红条，鼠标悬停看原因；右侧圆形箭头按钮可以重跑一次体检。',
  },
  {
    anchor: 'session.snapshot',
    placement: 'bottom',
    before: ensureSession,
    title: '刷新快照：同步工具箱配置',
    body:
      '它重建「工具箱当前配置」快照并重挂技能。刚在「目标」页装了新技能、改过注入或换过供应商，就点一下 —— 不点的话爱丽丝下一轮读的还是旧快照。',
  },
  {
    anchor: 'session.thread',
    placement: 'top',
    before: ensureSession,
    title: '对话区：这一轮的来龙去脉',
    body:
      '消息按 USER / AGENT 分列排下来，回复右下角的小图标复制正文。带「过程 N 步」的回复可以点开，看它这一轮调了哪些命令和工具。',
  },
  {
    anchor: 'session.composer',
    placement: 'top',
    before: ensureSession,
    title: '输入框：把活派出去的地方',
    body:
      'Enter 发送、Shift+Enter 换行，也能直接 Ctrl+V 粘图或点左边的图片按钮。同一个会话自动续聊同一份上下文；运行中「发送」旁边会出现「停止」，随时能掐掉本轮。',
  },
  {
    title: '会话页主线记住这三步',
    body:
      '选一个会话 → 需要就改提示词、点刷新快照 → 在输入框把活派出去。细节忘了随时点右上「使用教程」重看；真要跑外部 codex CLI，去「Alice-codex」页。',
  },
]
