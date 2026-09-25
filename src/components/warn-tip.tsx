import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'

/**
 * 警告图标 + 悬停说明气泡。
 *
 * 为什么不用纯 CSS 的 absolute 气泡：卡片列表的祖先链上有 `overflow: auto/hidden`
 * （`.tgt-scroll`、卡片容器等），absolute 气泡会被祖先裁掉 ——
 * 实际表现就是「气泡被组件盖住 / 顶部被切掉」。
 *
 * 这里改成 **portal 到 body + position: fixed**，再用 JS 量出图标的
 * getBoundingClientRect 来定位，完全不受祖先 overflow 与 z-index 影响。
 * 空间不足时自动改到图标下方显示。
 */
export function WarnTip({ children }: { children: ReactNode }) {
  const iconRef = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<null | { left: number; top: number; below: boolean }>(null)

  const show = useCallback(() => {
    const el = iconRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // 上方空间不够（贴顶）就改到下方，避免气泡出屏
    const below = r.top < 130
    // 水平方向夹在视口内，避免贴左右边缘时气泡被切
    const half = Math.min(170, window.innerWidth / 2 - 8)
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    setPos({ left, top: below ? r.bottom + 8 : r.top - 8, below })
  }, [])

  const hide = useCallback(() => setPos(null), [])

  return (
    <>
      <span
        ref={iconRef}
        className="warn-tip-icon"
        onMouseEnter={show}
        onMouseLeave={hide}
        // 触屏/键盘也能唤出
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
      >
        <AlertTriangle size={11} className="text-warn" />
      </span>
      {pos &&
        createPortal(
          <div
            className={`warn-tip-float${pos.below ? ' below' : ''}`}
            style={{ left: pos.left, top: pos.top }}
            onMouseEnter={hide}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}
