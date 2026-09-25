import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 出错时显示的面板标题（用于定位是哪个页面崩了） */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * 页面级错误边界。
 *
 * 之前踩过：会话页在没有会话时 `current.messages` 空值解引用，
 * 渲染期抛 TypeError → 整个 React 树卸载 → 用户看到纯白屏幕，
 * 且没有任何提示，只能靠翻代码猜。
 * 有边界后最坏情况是单页显示错误详情 + 重试按钮，其余功能不受影响。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台保留完整堆栈，便于 dev 排查
    console.error('[Alice] 页面渲染异常:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="page">
        <div className="page-body">
          <div className="glass glass-iridescent glass-pad" style={{ maxWidth: 760 }}>
            <div className="panel-head">
              <span className="kicker">RENDER ERROR / 渲染异常</span>
            </div>
            <h2 className="h2" style={{ marginBottom: 8 }}>
              {this.props.label ? `「${this.props.label}」页面出错` : '页面出错'}
            </h2>
            <div className="sub" style={{ marginBottom: 12 }}>
              界面已隔离该错误，其他功能仍可使用。下面是真实报错内容。
            </div>
            <pre className="error-trace">{error.message}</pre>
            {error.stack && <pre className="error-trace dim">{error.stack.split('\n').slice(0, 8).join('\n')}</pre>}
            <div className="row gap" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
                重试渲染
              </button>
              <button className="btn" onClick={() => window.location.reload()}>
                重载应用
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
