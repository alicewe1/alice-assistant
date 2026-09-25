import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({
  title,
  onClose,
  children,
  width = 640,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="glass glass-strong modal-card anim-pop"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="h2">{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** 通用删除确认，避免误触 */
export function useConfirm() {
  const [pending, setPending] = useState<null | { text: string; onYes: () => void }>(null)

  const confirm = useCallback((text: string, onYes: () => void) => {
    setPending({ text, onYes })
  }, [])

  const node = pending ? (
    <Modal title="确认操作" onClose={() => setPending(null)} width={420}>
      <p style={{ margin: '0 0 18px' }}>{pending.text}</p>
      <div className="row gap" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => setPending(null)}>
          取消
        </button>
        <button
          className="btn btn-danger"
          onClick={() => {
            pending.onYes()
            setPending(null)
          }}
        >
          确认删除
        </button>
      </div>
    </Modal>
  ) : null

  return { confirm, confirmNode: node }
}
