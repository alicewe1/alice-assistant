import { Check } from 'lucide-react'

/**
 * 药丸开关（图二样式）：开 = 墨色药丸 + 白色圆钮靠右；关 = 浅底 + 白钮靠左。
 * 复用全站已有的 .toggle 视觉语言，技能勾选/配置开关都用它，不再出现方框 checkbox。
 */
export function Switch({
  on,
  onChange,
  label,
  disabled,
  size = 'md',
}: {
  on: boolean
  onChange: (next: boolean) => void
  /** 无障碍名（技能名），同时作为 title 提示 */
  label?: string
  disabled?: boolean
  size?: 'md' | 'sm'
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label ? `${label}：${on ? '已勾选' : '未勾选'}` : undefined}
      disabled={disabled}
      className={`toggle${on ? ' on' : ''}${size === 'sm' ? ' toggle-sm' : ''}`}
      onClick={(e) => {
        // 行本身也可点（展开详情），这里别把行点击一起触发
        e.stopPropagation()
        onChange(!on)
      }}
    >
      <span className="toggle-thumb" />
    </button>
  )
}

/** 汇总行用的迷你勾选标记（面板头 / 计数徽标同行） */
export function PickTick({ on }: { on: boolean }) {
  return <span className={`pick-tick${on ? ' on' : ''}`}>{on ? <Check size={10} strokeWidth={3} /> : null}</span>
}
