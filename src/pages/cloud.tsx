import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Plus, RefreshCw, RotateCcw, Save, Square, Trash2, X, Zap } from 'lucide-react'
import { useStore } from '@/lib/store'
import { useApp } from '@/lib/app-context'
import { Topbar } from '@/components/topbar'
import { Modal } from '@/components/modal'
import * as be from '@/lib/tauri'
import type { CloudConfigDto, CloudStatsDto, RulePairDto } from '@/lib/tauri'

const DEFAULT_CFG: CloudConfigDto = {
  listenHost: '127.0.0.1',
  listenPort: 14649,
  autoStart: true,
  maxRetry: 2,
  upstreamMode: 'openai',
  upstreamUrl: '',
  apiKey: '',
  line: 'chat',
  model: '',
  testModel: '',
  featGreetingGate: true,
  featInjectInstructions: true,
  featSensitiveRewrite: true,
  featTokenizeTargets: true,
  featWarmupHistory: true,
  featMultiWaveRetry: true,
  featResponseClean: true,
  featWashSystem: true,
  rewrites: [],
  refusals: [],
}

function SwitchRow({
  title,
  desc,
  on,
  onToggle,
  dataTour,
}: {
  title: string
  desc: string
  on: boolean
  onToggle: () => void
  /** 教程锚点：只挂在「RULES / 改写与判定」第一条开关上，代表整组功能开关 */
  dataTour?: string
}) {
  return (
    <div className="cfg-row" data-tour={dataTour}>
      <div className="cfg-copy">
        <div className="cfg-title">{title}</div>
        <div className="cfg-desc">{desc}</div>
      </div>
      <button
        className={`toggle${on ? ' on' : ''}`}
        onClick={onToggle}
        aria-pressed={on}
        aria-label={title}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  )
}

export function Cloud() {
  const { pushLog, logs, backendLive } = useStore()
  const { toast } = useApp()

  const [cfg, setCfg] = useState<CloudConfigDto>(DEFAULT_CFG)
  const [saved, setSaved] = useState<CloudConfigDto>(DEFAULT_CFG)
  const [stats, setStats] = useState<CloudStatsDto | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [showRules, setShowRules] = useState(false)
  /** 外置洗白规则表 JSON 文件的绝对路径（打开编辑器时读取） */
  const [rulesPath, setRulesPath] = useState('')

  // 开关即时生效需要防抖推送（避免连续点击打爆 IPC）
  const pushTimer = useRef<number | null>(null)

  const applyCfg = useCallback(
    async (next: CloudConfigDto, quiet = false) => {
      try {
        const r = await be.cloudConfigSet(next)
        setSaved(r)
        // 运行中：Rust 侧热更新，下一请求立即用新配置
        if (!quiet) pushLog('[cloud] 配置已应用（运行中即时生效）', 'ok')
      } catch (e) {
        toast(`应用失败：${String(e)}`, 'bad')
      }
    },
    [pushLog, toast],
  )

  /** 改开关：本地立即变，并防抖持久化（运行中的代理会热更新） */
  const patch = (p: Partial<CloudConfigDto>) => {
    setCfg((c) => {
      const next = { ...c, ...p }
      if (pushTimer.current) window.clearTimeout(pushTimer.current)
      pushTimer.current = window.setTimeout(() => void applyCfg(next, true), 350)
      return next
    })
  }

  const refresh = useCallback(async () => {
    if (!be.IS_TAURI) return
    try {
      const [c, s, st] = await Promise.all([
        be.cloudConfigGet(),
        be.cloudStats(),
        be.cloudProxyStatus(),
      ])
      setCfg(c)
      setSaved(c)
      setStats(s)
      setRunning(st.ok)
    } catch (e) {
      pushLog(`[cloud] 读取配置失败：${String(e)}`, 'err')
    }
  }, [pushLog])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => {
      if (be.IS_TAURI) void be.cloudStats().then(setStats).catch(() => {})
    }, 3000)
    return () => window.clearInterval(t)
  }, [refresh])

  const toggleServer = async () => {
    setBusy(true)
    try {
      if (running) {
        await be.cloudProxyStop()
        setRunning(false)
        toast('本地服务端已停止', 'warn')
      } else {
        const r = await be.cloudProxyStart(cfg)
        if (r.ok) {
          setRunning(true)
          setSaved(cfg)
          toast(`本地服务端已启动：${r.listen}`, 'ok')
        } else {
          toast(`启动失败：${r.error}`, 'bad')
        }
      }
      void refresh()
    } catch (e) {
      toast(`后端不可用：${String(e)}`, 'warn')
    } finally {
      setBusy(false)
    }
  }

  const runSelftest = async () => {
    setBusy(true)
    try {
      const s = await be.cloudSelftest(cfg)
      setStats(s)
      toast(s.selftestOk ? '自检通过' : '自检失败（见日志）', s.selftestOk ? 'ok' : 'bad')
    } catch (e) {
      toast(`自检失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const fetchModels = async () => {
    setBusy(true)
    try {
      const list = await be.cloudModelsFetch(cfg)
      setModels(list)
      toast(list.length ? `获取到 ${list.length} 个模型` : '未获取到模型', list.length ? 'ok' : 'warn')
    } catch (e) {
      toast(`获取模型失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  /** 还原默认：清空自定义规则 + 开关全开（保留上游与密钥） */
  const resetDefaults = async () => {
    setBusy(true)
    try {
      const r = await be.cloudConfigReset()
      setCfg(r)
      setSaved(r)
      toast('已还原默认（开关全开 · 内置规则）', 'ok')
    } catch (e) {
      toast(`还原失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 打开规则表弹窗。
   *
   * 预览内容取「当前真实生效的规则」：若配置里没写自定义洗白表，
   * 就把内置默认 + 外置文件规则填进编辑框 —— 否则用户打开弹窗看到
   * 空表会以为没有规则在跑。此时若直接点「保存并应用」，
   * 会把内置表固化进配置；这正是用户要的「所见即所改」，故不做拦截。
   */
  const openRuleEditor = async () => {
    setBusy(true)
    try {
      setShowRules(true)
      try {
        setRulesPath(await be.cloudRulesFilePath())
      } catch {
        setRulesPath('(路径获取失败，请确认应用版本)')
      }
      const d = await be.cloudDefaults()
      setCfg((c) => ({
        ...c,
        rewrites: c.rewrites.length ? c.rewrites : d.rewrites,
        refusals: c.refusals.length ? c.refusals : d.refusals,
      }))
    } catch (e) {
      toast(`加载规则失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  /** 在资源管理器中打开规则表所在文件夹（文件不存在会自动生成模板） */
  const openRulesFolder = async () => {
    try {
      const p = await be.cloudRulesOpenFolder()
      setRulesPath(p)
      pushLog('[cloud] 已打开规则表所在文件夹', 'ok')
    } catch (e) {
      toast(`打开文件夹失败：${String(e)}`, 'bad')
    }
  }

  /** 重载外置规则表：用户改完 JSON 保存后点此立即生效 */
  const reloadRules = async () => {
    setBusy(true)
    try {
      const n = await be.cloudRulesReload()
      toast(`外置规则表已重载：${n} 条`, 'ok')
      pushLog(`[cloud] 外置规则表已重载：${n} 条`, 'ok')
    } catch (e) {
      toast(`重载失败：${String(e)}`, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved)
  const mine = logs.filter((l) => l.text.includes('[cloud]')).slice(-80)
  // 洗白表走外置文件，界面不再持有条目；判定表仍是配置内字段
  const ruleCount = {
    w: '文件',
    r: cfg.refusals.length || 8,
  }

  return (
    <div className="page anim-page">
      <Topbar
        kicker="CLOUD / 云过审"
        title="本地服务端"
        sub="连接你自己的中转站；客户端把 base_url 指到下面的地址即可。请求先按过云审逻辑改写用户提示词，再转发上游，响应回来后判定 / 还原 / 洗白再回传。"
        actions={
          <>
            <span className={`badge ${running ? 'badge-accent' : 'badge-neutral'}`}>
              {running ? '已启动' : '已停止'}
            </span>
            <span className={`badge ${backendLive ? 'badge-ok' : 'badge-neutral'}`}>
              {backendLive ? '后端已连接' : '浏览器预览'}
            </span>
            <button className="btn" data-tour="cloud.reset" disabled={busy} onClick={() => void resetDefaults()} title="开关全开、清空自定义规则（保留上游与密钥）">
              <RotateCcw size={13} /> 还原默认
            </button>
            <button className="btn btn-primary" data-tour="cloud.save" disabled={busy || !dirty} onClick={() => void applyCfg(cfg)}>
              <Save size={13} /> 保存
            </button>
          </>
        }
      />

      <div className="page-body cloud-grid">
        {/* ============ 左列 ============ */}
        <div className="col gap">
          {/* 本地服务端 */}
          <div className="glass glass-iridescent glass-pad" data-tour="cloud.server">
            <div className="panel-head">
              <span className="kicker">SERVER / 本地服务端</span>
              <span className={`badge ${running ? 'badge-ok' : 'badge-neutral'}`}>
                {running ? '运行中' : '已停止'}
              </span>
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">监听地址</div>
                <div className="cfg-desc mono">{cfg.listenHost}:{cfg.listenPort}</div>
              </div>
              <div className="row gap">
                <input
                  className="input mono"
                  style={{ width: 118 }}
                  value={cfg.listenHost}
                  disabled={running}
                  onChange={(e) => patch({ listenHost: e.target.value })}
                />
                <input
                  className="input mono"
                  style={{ width: 84 }}
                  value={cfg.listenPort}
                  disabled={running}
                  onChange={(e) => patch({ listenPort: Number(e.target.value) || 0 })}
                />
              </div>
            </div>

            <SwitchRow
              title="随工具启动"
              desc="打开工具后自动启动，退出时自动停止"
              on={cfg.autoStart}
              onToggle={() => patch({ autoStart: !cfg.autoStart })}
            />

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">最大重试波次</div>
                <div className="cfg-desc">事务式缓冲：整段取回上游响应后再判定与还原，因此可以改写响应。</div>
              </div>
              <input
                className="input mono"
                style={{ width: 70 }}
                value={cfg.maxRetry}
                onChange={(e) => patch({ maxRetry: Number(e.target.value) || 0 })}
              />
            </div>

            <div className="cfg-row" data-tour="cloud.stats">
              <div className="cfg-copy">
                <div className="cfg-title">自检 / 统计</div>
                <div className="cfg-desc mono" style={{ fontSize: 11 }}>
                  请求 {stats?.requests ?? 0} · 命中 {stats?.hits ?? 0} · 重试 {stats?.retries ?? 0} · 灰盒{' '}
                  {stats?.graybox ?? 0} · 洗白 {stats?.cleaned ?? 0} · 闸门 {stats?.gates ?? 0} · 错误{' '}
                  {stats?.errors ?? 0}
                </div>
              </div>
              <span
                className={`badge ${
                  stats?.selftestOk === true ? 'badge-ok' : stats?.selftestOk === false ? 'badge-bad' : 'badge-neutral'
                }`}
              >
                {stats?.selftestOk === true ? '自检通过' : stats?.selftestOk === false ? '自检失败' : '未自检'}
              </span>
            </div>
            {stats?.selftestDetail && (
              <div className="sub mono" style={{ fontSize: 10.5, marginTop: 4, wordBreak: 'break-all' }}>
                {stats.selftestDetail}
              </div>
            )}

            <div className="row gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" data-tour="cloud.start" disabled={busy} onClick={toggleServer}>
                {running ? (
                  <>
                    <Square size={13} /> 停止
                  </>
                ) : (
                  <>
                    <Play size={13} /> 启动服务端
                  </>
                )}
              </button>
              <button className="btn" disabled={busy || !running} onClick={runSelftest}>
                <Zap size={13} /> 中转站自检
              </button>
              <button className="btn" disabled={busy} onClick={() => void refresh()}>
                <RefreshCw size={13} /> 刷新
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void be.cloudStatsReset().then(() => setStats(null))}
                title="统计清零"
              >
                <Trash2 size={13} /> 清零
              </button>
            </div>
          </div>

          {/* 上游中转站 */}
          <div className="glass glass-iridescent glass-pad" data-tour="cloud.upstream">
            <div className="panel-head">
              <span className="kicker">UPSTREAM / 上游中转站</span>
              <span className={`badge ${cfg.upstreamUrl ? 'badge-ok' : 'badge-neutral'}`}>
                {cfg.upstreamUrl ? '已配置' : '未配置'}
              </span>
            </div>
            <div className="sub" style={{ marginBottom: 10 }}>
              openai = 你自己的网关/中转站（走 /responses 或 /chat/completions）；tamper-proxy =
              服务端过云审接口（请求体包在 request_body 里，规则由服务端执行）。
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">接口形态</div>
                <div className="cfg-desc">OpenAI 兼容（{cfg.upstreamMode}）</div>
              </div>
              <select
                className="select"
                style={{ width: 150 }}
                value={cfg.upstreamMode}
                onChange={(e) => patch({ upstreamMode: e.target.value })}
              >
                <option value="openai">openai</option>
                <option value="tamper-proxy">tamper-proxy</option>
              </select>
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">上游地址</div>
                <div className="cfg-desc">例如 https://ai.example.com/v1 或 https://l.lyly.asia/v1</div>
              </div>
              <input
                className="input mono"
                style={{ width: 280 }}
                value={cfg.upstreamUrl}
                placeholder="https://your-relay.example/v1"
                onChange={(e) => patch({ upstreamUrl: e.target.value })}
              />
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">API Key</div>
                <div className="cfg-desc">写入上游 Authorization: Bearer</div>
              </div>
              <input
                className="input"
                type="password"
                style={{ width: 280 }}
                value={cfg.apiKey}
                placeholder="sk-..."
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">线路</div>
                <div className="cfg-desc">responses 走 /responses，chat 走 /chat/completions。自检探测哪条线路真的可用。</div>
              </div>
              <select
                className="select"
                style={{ width: 118 }}
                value={cfg.line}
                onChange={(e) => patch({ line: e.target.value })}
              >
                <option value="chat">chat</option>
                <option value="responses">responses</option>
              </select>
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">使用模型</div>
                <div className="cfg-desc">转发上游时统一用这个模型（客户端自己的模型名上游通常不认）。</div>
              </div>
              <div className="row gap">
                <input
                  className="input mono"
                  style={{ width: 200 }}
                  list="alice-models"
                  value={cfg.model}
                  onChange={(e) => patch({ model: e.target.value })}
                />
                <button className="btn btn-sm" disabled={busy} onClick={fetchModels}>
                  获取模型
                </button>
              </div>
            </div>

            <div className="cfg-row">
              <div className="cfg-copy">
                <div className="cfg-title">自检模型</div>
                <div className="cfg-desc">自检只用这一个模型，避免误用其它模型产生费用。留空则用「使用模型」。</div>
              </div>
              <div className="row gap">
                <input
                  className="input mono"
                  style={{ width: 200 }}
                  list="alice-models"
                  value={cfg.testModel}
                  placeholder="留空 = 使用模型"
                  onChange={(e) => patch({ testModel: e.target.value })}
                />
                <button className="btn btn-sm" disabled={busy} onClick={fetchModels}>
                  获取模型
                </button>
              </div>
            </div>

            <datalist id="alice-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        </div>

        {/* ============ 右列 ============ */}
        <div className="col gap">
          {/* 改写与判定 */}
          <div className="glass glass-iridescent glass-pad" data-tour="cloud.rules">
            <div className="panel-head">
              <span className="kicker">RULES / 改写与判定</span>
              <span className="badge badge-neutral">
                洗白 {ruleCount.w} · 判定 {ruleCount.r}
              </span>
            </div>
            <div className="sub" style={{ marginBottom: 10 }}>
              请求侧按「RAW 直发 → 洗白 → 令牌化 → 预热历史 → 续跑 → 意图重述」逐级升级；响应侧做
              win/soft/policy/retry 判决与静默替换。
              <strong style={{ color: 'var(--ok)' }}> 开关改动即时生效，无需重启服务端。</strong>
            </div>

            <SwitchRow
              dataTour="cloud.features"
              title="纯问候闸门"
              desc="hi/hello/你好/在吗 完全匹配时直接回握手标记，不走上游"
              on={cfg.featGreetingGate}
              onToggle={() => patch({ featGreetingGate: !cfg.featGreetingGate })}
            />
            <SwitchRow
              title="指令注入"
              desc="升级波次时补 LAB_INSTRUCTIONS（执行模板 + 进度/稳定性段落）"
              on={cfg.featInjectInstructions}
              onToggle={() => patch({ featInjectInstructions: !cfg.featInjectInstructions })}
            />
            <SwitchRow
              title="敏感词洗白"
              desc="本地规则表：单遍、表序优先、重叠丢弃；不级联替换。覆盖 system 与全部历史轮次"
              on={cfg.featSensitiveRewrite}
              onToggle={() => patch({ featSensitiveRewrite: !cfg.featSensitiveRewrite })}
            />
            <SwitchRow
              title="目标令牌化"
              desc="URL/路径/IP/域名 → 占位符；CVE 编号原样透传"
              on={cfg.featTokenizeTargets}
              onToggle={() => patch({ featTokenizeTargets: !cfg.featTokenizeTargets })}
            />
            <SwitchRow
              title="上下文预热"
              desc="被上游拒答一次后，重发时前置一段良性技术语境，帮助对话继续"
              on={cfg.featWarmupHistory}
              onToggle={() => patch({ featWarmupHistory: !cfg.featWarmupHistory })}
            />
            <SwitchRow
              title="多波重试"
              desc="软拒/灰盒时升级重发，末波做意图重述（保留实体）"
              on={cfg.featMultiWaveRetry}
              onToggle={() => patch({ featMultiWaveRetry: !cfg.featMultiWaveRetry })}
            />
            <SwitchRow
              title="响应洗白"
              desc="命中软拒模板时静默整段替换，不把拒答发给客户端"
              on={cfg.featResponseClean}
              onToggle={() => patch({ featResponseClean: !cfg.featResponseClean })}
            />

            <div className="row gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" disabled={busy} onClick={() => void openRuleEditor()}>
                规则表文件
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void resetDefaults()}>
                <RotateCcw size={12} /> 还原默认
              </button>
              {dirty && (
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void applyCfg(cfg)}>
                  <Save size={12} /> 保存改动
                </button>
              )}
            </div>
          </div>

          {/* 规则表编辑器：弹出式模态（可编辑规则 + 可文件导入导出） */}
          {showRules && (
            <Modal title="规则表编辑" onClose={() => setShowRules(false)} width={860}>
              {/* ── 文件导入/导出区 ───────────────────────────── */}
              <div className="sub" style={{ marginBottom: 8 }}>
                洗白规则持久化在<strong>外置 JSON 文件</strong>里：复制走即为导出，覆盖回来即为导入，
                也可以在下方表格直接增删改。文件改动保存后点「重载规则」立即生效，无需重启代理。
              </div>
              <div className="cfg-desc mono" style={{ wordBreak: 'break-all', marginBottom: 8 }}>
                {rulesPath || '读取中…'}
              </div>
              <div className="row gap" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
                <button className="btn btn-sm" onClick={() => void openRulesFolder()}>
                  打开文件所在文件夹
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => void reloadRules()}>
                  <RefreshCw size={12} /> 重载规则（按文件刷新）
                </button>
              </div>

              {/* ── 洗白规则编辑区 ───────────────────────────── */}
              <div className="kicker" style={{ margin: '4px 0 6px' }}>
                REWRITES / 洗白规则（匹配 → 替换）
              </div>
              <div className="col gap-sm" style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 8 }}>
                {cfg.rewrites.length === 0 && (
                  <div className="sub">暂无自定义规则 —— 空表时自动使用内置 31 条 + 外置文件规则。</div>
                )}
                {cfg.rewrites.map((r, i) => (
                  <div key={i} className="rule-edit-row">
                    <input
                      className="input mono"
                      style={{ flex: 1.2 }}
                      placeholder="敏感词或正则"
                      value={r.from}
                      onChange={(e) => {
                        const next = [...cfg.rewrites]
                        next[i] = { ...next[i], from: e.target.value }
                        patch({ rewrites: next })
                      }}
                    />
                    <span className="rule-arrow">→</span>
                    <input
                      className="input mono"
                      style={{ flex: 1 }}
                      placeholder="中性表述"
                      value={r.to}
                      onChange={(e) => {
                        const next = [...cfg.rewrites]
                        next[i] = { ...next[i], to: e.target.value }
                        patch({ rewrites: next })
                      }}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => patch({ rewrites: cfg.rewrites.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="row gap" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => patch({ rewrites: [...cfg.rewrites, { from: '', to: '' }] })}
                >
                  <Plus size={12} /> 新增洗白规则
                </button>
                <span className="cfg-desc">
                  内置 31 条始终生效；这里的自定义条目会追加在其后（同名匹配以内置为准）。
                </span>
              </div>

              {/* ── 判定正则编辑区 ───────────────────────────── */}
              <div className="kicker" style={{ margin: '4px 0 6px' }}>
                REFUSALS / 判定正则（响应侧拒答判决）
              </div>
              <div className="col gap-sm" style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 8 }}>
                {cfg.refusals.map((r, i) => (
                  <div key={i} className="rule-edit-row">
                    <input
                      className="input mono"
                      style={{ flex: 1 }}
                      value={r}
                      onChange={(e) => {
                        const next = [...cfg.refusals]
                        next[i] = e.target.value
                        patch({ refusals: next })
                      }}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => patch({ refusals: cfg.refusals.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="row gap" style={{ marginBottom: 14 }}>
                <button className="btn btn-sm" onClick={() => patch({ refusals: [...cfg.refusals, ''] })}>
                  <Plus size={12} /> 新增判定规则
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => void resetDefaults()}>
                  <RotateCcw size={12} /> 还原默认
                </button>
              </div>

              {/* ── 底部操作 ───────────────────────────── */}
              <div className="row gap" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setShowRules(false)}>
                  关闭
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void applyCfg(cfg)}
                >
                  <Save size={12} /> 保存并应用
                </button>
              </div>
            </Modal>
          )}

          {/* 运行日志 */}
          <div className="glass glass-iridescent glass-pad" data-tour="cloud.log">
            <div className="panel-head">
              <span className="kicker">LOG / 运行日志</span>
              <span className="badge badge-neutral">{mine.length} 条</span>
            </div>
            {mine.length === 0 ? (
              <div className="sub">暂无日志。启动服务端后，每次请求的波次与判决会显示在这里。</div>
            ) : (
              <div className="runtime-log" style={{ maxHeight: 420 }}>
                {mine.map((l, i) => (
                  <div key={i} className="runtime-log-line">
                    <span className="runtime-log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
                    <span className={`runtime-log-text log-${l.kind}`}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
