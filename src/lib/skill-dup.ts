import type { SkillItemDto, SkillPackDto } from '@/lib/tauri'

/**
 * 技能查重。
 *
 * 场景：多个技能包里可能有同名技能（例如 codex-skills 与 codex-skills-v5
 * 都带 `ida-reverse`）。直接按名字合并会静默用错一份，所以这里把重名项
 * 全部列出来，让用户自己选「这一组用哪个包里的那份」。
 *
 * 用法：
 *   const dups = findSkillDuplicates(packs)
 *   // dups: [{ name, options: [{ packId, packTitle, item }] }]
 *   // 用户的决定存 pick: { [skillName]: packId }
 *   const chosen = resolveSkillChoice(dups, pick, name)
 */
export interface SkillDupOption {
  packId: string
  packTitle: string
  item: SkillItemDto
}

export interface SkillDuplicate {
  name: string
  options: SkillDupOption[]
}

/** 找出跨包同名的技能（同名出现在 2 个及以上包里才算重名） */
export function findSkillDuplicates(packs: SkillPackDto[]): SkillDuplicate[] {
  const byName = new Map<string, SkillDupOption[]>()
  for (const p of packs) {
    for (const s of p.skills) {
      if (!byName.has(s.name)) byName.set(s.name, [])
      byName.get(s.name)!.push({ packId: p.id, packTitle: p.title || p.id, item: s })
    }
  }
  const out: SkillDuplicate[] = []
  for (const [name, options] of byName) {
    if (options.length > 1) out.push({ name, options })
  }
  // 稳定排序，界面顺序不跳动
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 该技能最终采用哪个包里的那一份（用户没选就取第一个） */
export function resolveSkillChoice(
  dups: SkillDuplicate[],
  pick: Record<string, string>,
  name: string,
): SkillDupOption | null {
  const d = dups.find((x) => x.name === name)
  if (!d) return null
  const chosenPack = pick[name]
  return d.options.find((o) => o.packId === chosenPack) ?? d.options[0]
}

/** 重名技能名集合（用于列表上打标记） */
export function duplicateNames(dups: SkillDuplicate[]): Set<string> {
  return new Set(dups.map((d) => d.name))
}
