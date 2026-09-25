import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Theme } from '@/types/domain'

interface Toast {
  id: number
  kind: 'info' | 'ok' | 'warn' | 'bad'
  text: string
  /** 到期时间戳（ms）；到期后由全局 tick 清除 */
  expiresAt: number
}

interface AppCtx {
  theme: Theme
  toggleTheme: () => void
  toasts: Toast[]
  toast: (text: string, kind?: Toast['kind']) => void
  dismiss: (id: number) => void
}

const Ctx = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('AppProvider missing')
  return v
}

let toastSeq = 1
const TOAST_MS = 4200

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('alice-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('alice-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  /** 相同文案+级别的提示只显示一条，重复触发只刷新它的到期时间，不堆叠 */
  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const expiresAt = Date.now() + TOAST_MS
    setToasts((list) => {
      const dup = list.find((t) => t.text === text && t.kind === kind)
      if (dup) return list.map((t) => (t.id === dup.id ? { ...t, expiresAt } : t))
      return [...list.slice(-4), { id: toastSeq++, kind, text, expiresAt }]
    })
  }, [])

  // 有提示在展示时开一个低频 tick 负责到期清除
  useEffect(() => {
    if (!toasts.length) return
    const iv = window.setInterval(() => {
      const now = Date.now()
      setToasts((list) => {
        const next = list.filter((t) => t.expiresAt > now)
        return next.length === list.length ? list : next
      })
    }, 500)
    return () => window.clearInterval(iv)
  }, [toasts.length])

  const value = useMemo(
    () => ({ theme, toggleTheme, toasts, toast, dismiss }),
    [theme, toggleTheme, toasts, toast, dismiss],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
