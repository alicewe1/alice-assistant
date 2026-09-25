import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * Vite watcher 白名单：只监听真正参与前端的文件。
 *
 * 踩过的三个坑（都会让 node 进程 EBUSY 直接崩，且不报编译错误）：
 *  1. 黑名单写法 `ignored: ['**\/src-tauri/**']` 在 chokidar 4 下静默失效，
 *     watcher 去 watch src-tauri/target 里正被链接器锁定的 .exe；
 *  2. 项目根出现任何被占用的杂物文件（例如 `$null`），黑名单也挡不住；
 *  3. **白名单也不够** —— 原子写会在 src/ 内部造临时目录
 *     （实测：`src/styles/.tokens.css.<pid>.<guid>.tmpdir/tokens.css.tmp`），
 *     它落在白名单内且正被写锁持有 ⇒ 照样 EBUSY 崩掉整个 node。
 * 所以规则是「白名单 + 排除一切点开头/临时名」，两道都要。
 */
const SOURCE_TOP = new Set(['src', 'public'])

/** 点开头的目录/文件与常见临时后缀：原子写的中间产物，永远不要监听 */
const isTempPath = (rel: string) =>
  rel.split(path.sep).some((seg) => seg.startsWith('.')) ||
  /\.(tmp|temp|swp|swx|bak|~)$/i.test(rel) ||
  rel.includes('.tmpdir')

const watchOnly = (p: string) => {
  const rel = path.relative(projectRoot, path.resolve(p))
  // 项目根本身要保留监听（新文件出现才能被发现）
  if (rel === '' || rel.startsWith('..')) return false
  if (isTempPath(rel)) return true
  if (rel === 'index.html' || rel === 'vite.config.ts' || rel === 'package.json') return false
  const top = rel.split(path.sep)[0]
  // 只放行 src/ 与 public/，其余全部忽略（含 node_modules / dist / src-tauri / 各种杂物）
  return !SOURCE_TOP.has(top)
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5183,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      ignored: watchOnly,
    },
  },
  build: {
    // Tauri 跑在 WebView2（Edge/Chromium）上，可直接用现代语法
    target: 'chrome110',
    sourcemap: false,
  },
  clearScreen: false,
})
