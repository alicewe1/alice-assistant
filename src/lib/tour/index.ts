import type { TourStep } from './types'
import { TARGETS_TOUR } from './targets'
import { SKILLS_TOUR } from './skills'
import { PROMPTS_TOUR } from './prompts'
import { SESSION_TOUR } from './session'
import { RUNTIME_TOUR } from './runtime'
import { CLOUD_TOUR } from './cloud'

export type { TourStep, TourPlacement, TourPage } from './types'
export { TARGETS_TOUR, SKILLS_TOUR, PROMPTS_TOUR, SESSION_TOUR, RUNTIME_TOUR, CLOUD_TOUR }

/**
 * 教程步骤总表：一个页面 = 一组步骤。
 *
 * 没有登记的页面（总览 / 消息中心）不显示「使用教程」按钮 ——
 * 宁可没有入口，也不要给一个点开是空的按钮。
 */
export const TOURS: Record<string, TourStep[]> = {
  targets: TARGETS_TOUR,
  skills: SKILLS_TOUR,
  prompts: PROMPTS_TOUR,
  session: SESSION_TOUR,
  runtime: RUNTIME_TOUR,
  cloud: CLOUD_TOUR,
}

/** 该页有没有教程（决定按钮显不显示 / 是否可点） */
export function hasTour(page: string): boolean {
  return (TOURS[page]?.length ?? 0) > 0
}

/**
 * 按 `data-tour` 键取当前页面上真实的 DOM 节点。
 *
 * 用引号包裹 + CSS.escape：锚点键里有点号（`targets.install-btn`），
 * 不转义会被当成类选择器解析，直接抛错。
 */
export function anchorOf(key: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(key)}"]`)
  } catch {
    return null
  }
}

/**
 * 模拟点击某个锚点。
 *
 * 给步骤的 `before` 用：有些面板是折叠的，先把它点开，下一步才能高亮到里面的内容。
 * 只点**展开/切换**类的安全锚点，任何会落盘、注入、删除的按钮都不要在这里点。
 */
export function clickAnchor(key: string): void {
  anchorOf(key)?.click()
}
