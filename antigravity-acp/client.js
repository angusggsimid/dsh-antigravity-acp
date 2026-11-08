window.__ModuleLoader__.load({
  id: '@local/dsh-antigravity-acp',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CACHE_KEY = 'dsh.agy.subscription.snapshot.v2'
    const FRESH_MS = 60_000
    const POLL_MS = 300_000

    /* ---------------- shared snapshot store ---------------- */
    let snapshot = readCache()
    let lastError = null
    let inFlight = null
    const listeners = new Set()

    function readCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && parsed.data ? parsed : null
      } catch {
        return null
      }
    }

    function publish(next) {
      snapshot = next
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(next)) } catch {}
      for (const listener of listeners) {
        try { listener() } catch {}
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    const getSnapshot = () => snapshot

    function refresh() {
      if (inFlight !== null) return inFlight
      inFlight = (async () => {
        try {
          const response = await fetch('/api/agy-subscription/status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const data = await response.json()
          if (data && data.ok) {
            lastError = null
            publish({ at: Date.now(), data })
          } else {
            lastError = data?.error ?? '未知错误'
            if (snapshot === null) publish({ at: Date.now(), data: { ok: false, error: lastError } })
            else for (const listener of listeners) { try { listener() } catch {} }
          }
        } catch (error) {
          lastError = String(error)
          if (snapshot === null) publish({ at: Date.now(), data: { ok: false, error: lastError } })
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    }

    function useSubscription() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const [, bump] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        const age = snapshot === null ? Infinity : Date.now() - snapshot.at
        if (age > FRESH_MS) void refresh()
        const timer = window.setInterval(() => void refresh(), POLL_MS)
        return () => window.clearInterval(timer)
      }, [])
      React.useEffect(() => {
        const listener = () => bump()
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return { state, error: lastError }
    }

    /* ---------------- formatting ---------------- */
    function percent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const pct = value * 100
      return `${pct >= 99.95 ? '100' : pct.toFixed(1)}%`
    }

    function remainingText(stamp) {
      if (!stamp) return ''
      const target = new Date(stamp)
      if (Number.isNaN(target.getTime())) return ''
      const diff = target.getTime() - Date.now()
      if (diff <= 0) return '即将重置'
      const minutes = Math.round(diff / 60_000)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)
      if (days >= 1) return `${days} 天 ${hours % 24} 小时后重置`
      if (hours >= 1) return `${hours} 小时 ${minutes % 60} 分后重置`
      return `${minutes} 分后重置`
    }

    function ago(stamp) {
      if (!stamp) return '尚未更新'
      const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000))
      if (seconds < 60) return '刚刚更新'
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`
      return `${Math.floor(seconds / 3600)} 小时前更新`
    }

    function accent(value) {
      if (typeof value !== 'number') return '#8b8b8b'
      if (value > 0.5) return '#3fb950'
      if (value > 0.2) return '#d29922'
      return '#f85149'
    }

    /* ---------------- atoms ---------------- */
    const card = {
      border: '1px solid rgba(128,128,128,0.22)',
      borderRadius: '10px',
      padding: '14px 16px',
      background: 'rgba(128,128,128,0.05)',
    }

    function Meter({ fraction }) {
      const pct = typeof fraction === 'number' ? Math.max(0, Math.min(1, fraction)) : 0
      return h('div', {
        style: {
          height: '8px', borderRadius: '999px',
          background: 'rgba(128,128,128,0.22)', overflow: 'hidden',
        },
      }, h('div', {
        style: {
          width: `${pct * 100}%`, height: '100%', borderRadius: '999px',
          background: accent(fraction), transition: 'width .35s ease',
        },
      }))
    }

    function QuotaCard({ title, window: bucket }) {
      if (!bucket) return null
      return h('div', { style: card },
        h('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginBottom: '10px', fontSize: '13px', opacity: 0.75,
          },
        }, h('span', null, title), h('span', { style: { fontSize: '11px', opacity: 0.7 } }, bucket.label ?? '')),
        h('div', {
          style: {
            fontSize: '28px', fontWeight: 600, letterSpacing: '-0.5px',
            fontVariantNumeric: 'tabular-nums', marginBottom: '8px',
            color: accent(bucket.remaining),
          },
        }, percent(bucket.remaining)),
        h(Meter, { fraction: bucket.remaining }),
        h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '8px' } }, remainingText(bucket.resetTime)),
      )
    }

    function Line({ label, children, mono }) {
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: '104px 1fr', gap: '12px',
          padding: '5px 0', alignItems: 'baseline', fontSize: '13px',
        },
      },
        h('span', { style: { opacity: 0.6 } }, label),
        h('span', { style: mono ? { fontVariantNumeric: 'tabular-nums' } : undefined }, children))
    }

    function SectionTitle({ children, action }) {
      return h('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          margin: '22px 0 10px',
        },
      },
        h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: 600, letterSpacing: '0.02em', opacity: 0.85 } }, children),
        action ?? null)
    }

    function Skeleton() {
      return h('div', { style: { display: 'grid', gap: '12px', maxWidth: '720px' } },
        h('div', { style: { ...card, height: '64px', opacity: 0.5 } }),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
          h('div', { style: { ...card, height: '132px', opacity: 0.5 } }),
          h('div', { style: { ...card, height: '132px', opacity: 0.5 } })),
        h('div', { style: { fontSize: '12px', opacity: 0.5 } }, '第一次读取订阅信息…'))
    }

    /* ---------------- settings panel ---------------- */
    function Panel() {
      const { state, error } = useSubscription()
      const [busy, setBusy] = React.useState(false)

      if (state === null) return Skeleton()
      const data = state.data

      const manualRefresh = async () => {
        setBusy(true)
        try { await refresh() } finally { setBusy(false) }
      }

      const header = h('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: '16px', flexWrap: 'wrap',
        },
      },
        h('div', null,
          h('div', { style: { fontSize: '15px', fontWeight: 600 } }, data.ok ? 'Antigravity' : 'Antigravity（离线）'),
          h('div', { style: { fontSize: '12px', opacity: 0.65, marginTop: '2px' } },
            data.ok ? (data.account?.email ?? '已登录') : (error ?? data.error ?? '读取失败'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { style: { fontSize: '11px', opacity: 0.55 } }, ago(state.at)),
          h('button', {
            type: 'button',
            onClick: manualRefresh,
            disabled: busy,
            style: {
              fontSize: '12px', padding: '5px 12px', borderRadius: '7px',
              border: '1px solid rgba(128,128,128,0.3)', background: 'transparent',
              color: 'inherit', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 0.85,
            },
          }, busy ? '刷新中…' : '刷新')))

      if (!data.ok) {
        return h('div', { style: { maxWidth: '720px' } }, header,
          h('p', { style: { fontSize: '13px', opacity: 0.7, marginTop: '16px' } },
            '暂时读不到订阅。桥接或隧道可能没起来，点刷新重试。'))
      }

      const accounts = Array.isArray(data.accounts) && data.accounts.length > 0
        ? data.accounts
        : [{ name: 'Antigravity', ok: data.ok, error: data.error, gemini: data.gemini, account: data.account }]

      return h('div', { style: { maxWidth: '720px', color: 'inherit' } },
        header,

        h(SectionTitle, null, '额度'),
        ...accounts.map((account) => h('div', { key: account.id ?? account.name, style: { marginBottom: '14px' } },
          h('div', { style: { fontSize: '13px', fontWeight: 500, marginBottom: '8px' } },
            account.name ?? 'Antigravity',
            account.account?.email ? h('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: '8px' } }, account.account.email) : null),
          account.ok === false
            ? h('div', { style: { ...card, fontSize: '12px', opacity: 0.7 } }, account.error ?? '读取失败')
            : h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
              h(QuotaCard, { title: '5 小时窗口', window: account.gemini?.fiveHour ?? null }),
              h(QuotaCard, { title: '每周窗口', window: account.gemini?.weekly ?? null })))),

        h(SectionTitle, null, '模型'),
        h('div', { style: { display: 'grid', gap: '8px' } },
          (data.models ?? []).map((model) => h('div', {
            key: model.id,
            style: { ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' },
          },
            h('div', null,
              h('div', { style: { fontSize: '13px', fontWeight: 500 } }, model.name ?? model.id),
              h('div', { style: { fontSize: '11px', opacity: 0.55, marginTop: '2px' } }, model.id)),
            h('div', { style: { display: 'flex', gap: '4px' } },
              (model.efforts ?? []).length > 0
                ? model.efforts.map((effort) => h('span', {
                    key: effort,
                    style: {
                      fontSize: '11px', padding: '2px 8px', borderRadius: '999px',
                      background: 'rgba(128,128,128,0.16)', opacity: 0.8,
                    },
                  }, effort))
                : h('span', { style: { fontSize: '11px', opacity: 0.4 } }, '无档位'))))),

        h(SectionTitle, null, '连接'),
        h('div', { style: card },
          h(Line, { label: '通路' }, 'SSH 上的官方 agy acp'),
          h(Line, { label: '工具' }, '经反向隧道回到运行 DSH 的这台机器上执行'),
          h(Line, { label: '凭证' }, '登录态只留在远端的官方进程里'),
          h(Line, { label: '认证' }, '由本机 SSH 配置决定，不写进插件'),
          h(Line, { label: '数据' }, '提示词不记录；每个会话使用独立 bearer')),

        h('div', { style: { fontSize: '11px', opacity: 0.45, marginTop: '14px' } },
          '数据来自服务器上 Antigravity CLI 自己的 /usage 与 models 命令。'),
      )
    }

    /* ---------------- composer badge ---------------- */
    function Badge({ directory }) {
      const { state } = useSubscription()
      const modelState = React.useSyncExternalStore(
        (listener) => directory.subscribe(listener),
        () => directory.getSnapshot(),
        () => directory.getSnapshot(),
      )
      const provider = modelState?.current?.provider
      const data = state?.data
      if (!data?.ok) return null
      const accounts = Array.isArray(data.accounts) ? data.accounts : []
      const selected = accounts.find((account) => account.provider === provider)
        ?? (provider === 'antigravity' || provider === 'gemini' ? accounts[0] : null)
      if (!selected?.ok) return null
      const five = selected.gemini?.fiveHour
      const weekly = selected.gemini?.weekly
      if (!five && !weekly) return null
      const parts = []
      if (five) parts.push(`5h ${percent(five.remaining)}`)
      if (weekly) parts.push(`周 ${percent(weekly.remaining)}`)
      const title = [five, weekly].filter(Boolean)
        .map((bucket) => `${bucket.label ?? bucket.window}：${percent(bucket.remaining)}，${remainingText(bucket.resetTime)}`)
        .join('\n')
      return h('span', {
        title,
        style: {
          fontSize: '12px', opacity: 0.7, whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums', cursor: 'default',
        },
      }, parts.join(' · '))
    }

    return {
      inject: ['slots', 'modelDirectories'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'agy-subscription',
          order: 17,
          label: () => 'Antigravity 订阅',
        }, Panel))

        const install = (scope) => {
          let modelDirectories
          try { modelDirectories = scope.get?.('modelDirectories') ?? ctx.get?.('modelDirectories') } catch { modelDirectories = undefined }
          if (!modelDirectories?.directoryFor) return
          scope.slots.inject('conversation.input.right', () => scope.slots.register({
            name: 'conversation.input.right',
            id: 'agy-subscription-quota',
            order: 17,
            inject: (sessionId) => ({ directory: modelDirectories.directoryFor(sessionId).store }),
          }, Badge))
        }

        try {
          const remote = ctx.get?.('remote.session')
          if (remote === undefined) install(ctx)
          else ctx.inject(['remote.session'], install)
        } catch {
          install(ctx)
        }
      },
    }
  },
})
