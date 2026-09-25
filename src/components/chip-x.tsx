import { X } from 'lucide-react'

/** chip 内嵌的小移除按钮（用于已注入标签） */
export function ChipX({ onClick }: { onClick: () => void }) {
  return (
    <button className="chip-x" onClick={onClick}>
      <X size={10} />
    </button>
  )
}
