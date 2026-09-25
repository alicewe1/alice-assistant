/** 教程步骤的数据结构。页面文件只导出 `TourStep[]`，渲染统一由 components/tour.tsx 负责。 */

/** 气泡相对高亮块的方位；auto = 哪边放得下放哪边 */
export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto'

/** 有教程的页面（与 components/topnav.tsx 的 PageId + 顶栏铃铛进入的消息中心保持一致） */
export type TourPage =
  | 'dashboard'
  | 'targets'
  | 'skills'
  | 'prompts'
  | 'session'
  | 'messages'
  | 'runtime'
  | 'cloud'

export interface TourStep {
  /**
   * 定位键：页面元素上的 `data-tour="<key>"`。
   *
   * 元素**可以不在场**（比如要选中某个会话后右侧面板才出现）——
   * 这时这一步会退化成一张居中卡片，不会中断教程。所以别把关键信息
   * 只挂在有可能不存在的锚点上。
   */
  anchor?: string
  /** 标题：一句话说清「这是什么」 */
  title: string
  /** 正文：讲「该怎么用」，1~3 句，别写成说明书 */
  body: string
  /** 气泡方位，默认 auto */
  placement?: TourPlacement
  /** 高亮框相对锚点向外扩的像素，默认 8。紧了会切到内容，松了会框住旁边的东西 */
  pad?: number
  /**
   * 进入这一步前的准备动作：切子标签、展开面板、选中一行等。
   * 只做「展开/切换」，不要做会落盘或不可逆的操作。
   */
  before?: () => void
}
