import { useMemo, useState } from 'react'
import { ChevronDown, Search, Check } from 'lucide-react'
import type { SkillDuplicate } from '@/lib/skill-dup'
import { resolveSkillChoice } from '@/lib/skill-dup'

/**
 * 重名技能选择器。
 *
 * 为什么不用「每行横排一串来源」的表格：来源包一多（实测 5 个），
 * 固定列就把弹窗撑爆，横向滚不完；来源数量不齐时还会出现大量空格子。
 *
 * 这里的方案分三层，宽度恒定、行数再多也不失控：
 *   1) 工具栏 —— 搜索过滤 + 「批量来源」下拉 + 应用到全部
 *   2) 每行默认收起：技能名 + 当前采用来源（一行放得下）
 *   3) 点行展开：来源单选列表（只有被展开的那一行占空间）
 *
 * 110 条重名时，配合搜索和「应用到全部」，几步就能配完。
 */
export function DupSkillPicker({
  duplicates,
  pick,
  onPick,
  onApplyAll,
}: {
  duplicates: SkillDuplicate[]
  /** 技能名 → 选中的包 id（用户没选的项不在里面） */
  pick: Record<string, string>
  onPick: (name: string, packId: string) => void
  /** 把某个来源应用到所有重名技能 */
  onApplyAll: (packId: string) => void
}) {
  const [q, setQ] = useState('')
  const [batch, setBatch] = useState('')
  // 展开的行（技能名）。null = 全部收起
  const [openName, setOpenName] = useState<string | null>(null)
  /**
   * 是否隐藏「已经选好来源」的项（默认隐藏）。
   *
   * 用户诉求：选完一个重名来源后，这一项就该从待办里消失 ——
   * 否则 110 项列表里分不清哪些还没处理。隐藏后列表越来越短，
   * 剩下的就是真正待办；想回看/改选可以关掉这个开关。
   */
  const [hideDone, setHideDone] = useState(true)

  // 汇总所有来源包（去重），用于批量下拉
  const allSources = useMemo(() => {
    const seen = new Map<string, string>()
    for (const d of duplicates) for (const o of d.options) seen.set(o.packId, o.packTitle)
    return [...seen.entries()].map(([id, title]) => ({ id, title }))
  }, [duplicates])

  /** 用户已经手动选过来源的项数 */
  const doneCount = useMemo(
    () => duplicates.filter((d) => pick[d.name]).length,
    [duplicates, pick],
  )

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    // 已选好来源的项：默认不显示（除非在搜索，搜索时保留以便回看）
    let list = duplicates
    if (hideDone && !k) list = list.filter((d) => !pick[d.name])
    if (k) list = list.filter((d) => d.name.toLowerCase().includes(k))
    return list
  }, [duplicates, q, hideDone, pick])

  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
      {/* ---- 工具栏：搜索 + 批量来源 ---- */}
      <div className="dup-toolbar">
        <div style={{ position: 'relative', flex: 1, minWidth: 140 }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
          <input
            className="input"
            style={{ paddingLeft: 26, fontSize: 11.5, height: 28 }}
            placeholder={`搜索技能名（剩 ${duplicates.length - doneCount} / 共 ${duplicates.length} 项）`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {/* 隐藏已选：选完的来源项从待办里消失，列表越用越短 */}
        <label
          className="row gap"
          style={{ alignItems: 'center', flex: 'none', fontSize: 11, cursor: 'pointer' }}
          title="勾上后，已选好来源的技能会从列表里隐藏"
        >
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          隐藏已选
          {doneCount > 0 && <span className="badge badge-ok">已选 {doneCount}</span>}
        </label>
        <div className="row gap" style={{ alignItems: 'center', flex: 'none' }}>
          <select
            className="select"
            style={{ fontSize: 11, width: 160 }}
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            title="选一个来源，统一应用到下面所有重名技能"
          >
            <option value="">批量来源…</option>
            {allSources.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            disabled={!batch}
            title="把选中的来源应用到所有重名技能"
            onClick={() => batch && onApplyAll(batch)}
          >
            <Check size={12} /> 应用到全部
          </button>
        </div>
      </div>

      {/* ---- 列表 ---- */}
      <div className="dup-list">
        {filtered.length === 0 && (
          <div className="sub" style={{ padding: 12, fontSize: 11 }}>
            {q.trim()
              ? `没有匹配「${q}」的重名技能`
              : hideDone && doneCount > 0
                ? `全部 ${doneCount} 项都已选好来源 —— 关掉「隐藏已选」可以回看或改选。`
                : '没有重名技能 —— 各包技能名互不冲突。'}
          </div>
        )}
        {filtered.map((d) => {
          const chosen = resolveSkillChoice(duplicates, pick, d.name)
          const open = openName === d.name
          // 用户是否手动选过（没选 → 默认取第一个，标成「默认」）
          const manual = Boolean(pick[d.name])
          return (
            <div key={d.name} className={`dup-item${open ? ' open' : ''}`}>
              {/* 收起态：技能名 + 当前来源 + 展开箭头 */}
              <button
                className="dup-row"
                onClick={() => setOpenName(open ? null : d.name)}
                title={d.name}
              >
                <span className="dup-name mono">{d.name}</span>
                <span className={`dup-current${manual ? ' manual' : ''}`}>
                  {chosen?.packTitle ?? '—'}
                  {!manual && <span className="dup-def">默认</span>}
                </span>
                <span className="dup-count mono">{d.options.length}</span>
                <ChevronDown
                  size={13}
                  style={{
                    flex: 'none',
                    opacity: 0.5,
                    transform: open ? 'rotate(180deg)' : undefined,
                    transition: 'transform 0.15s ease',
                  }}
                />
              </button>

              {/* 展开态：来源单选 */}
              {open && (
                <div className="dup-options">
                  {d.options.map((o) => {
                    const on = chosen?.packId === o.packId
                    return (
                      <button
                        key={o.packId}
                        className={`dup-opt${on ? ' on' : ''}`}
                        title={o.item.path}
                        onClick={() => onPick(d.name, o.packId)}
                      >
                        <span className={`dup-tick${on ? ' on' : ''}`} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {o.packTitle}
                        </span>
                        <span className="dup-files mono">{o.item.files}文件</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
