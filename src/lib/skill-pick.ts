/**
 * 技能勾选的共享状态（技能库页 与 目标页安装筛选 共用同一份）。
 *
 * 语义：键为 `<技能包id>/<技能名>`，值为 false 表示「不装」。
 * 缺省（没有这个键）= 已勾选 —— 这样新加的技能默认就被安装，
 * 不会因为用户没点过而静默漏装。技能库页改的就是这份数据，
 * 目标页安装时按同一份数据过滤 skillFilter。
 */
export const SKILL_PICK_KEY = 'a6-skill-picked'

export type PickMap = Record<string, boolean>

export function loadSkillPick(): PickMap {
  try {
    const raw = localStorage.getItem(SKILL_PICK_KEY)
    return raw ? (JSON.parse(raw) as PickMap) : {}
  } catch {
    return {}
  }
}

export function saveSkillPick(m: PickMap) {
  try {
    localStorage.setItem(SKILL_PICK_KEY, JSON.stringify(m))
  } catch {
    /* 配额/隐私模式下忽略：勾选退化为本次会话内存态 */
  }
}

export const skillKey = (packId: string, name: string) => `${packId}/${name}`

/** 缺省视为已勾选 */
export const isSkillOn = (m: PickMap, packId: string, name: string) => m[skillKey(packId, name)] !== false

/** 一组技能里被勾选的（缺省即勾选） */
export function pickedOf(m: PickMap, packId: string, names: string[]): string[] {
  return names.filter((n) => isSkillOn(m, packId, n))
}
