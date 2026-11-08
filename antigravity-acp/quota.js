/**
 * Host half of the Antigravity subscription surface.
 *
 * The browser never sees the bridge key or the Google token. It asks this
 * process, which reads the configured credential and calls the loopback bridge.
 *
 * Two caches keep the settings panel instant:
 *  - this host keeps the last successful payload and answers stale-while-
 *    revalidate, so only the very first open waits for the server;
 *  - the client keeps the last payload in localStorage and renders it before
 *    any request is made.
 *
 * Quota comes from the CLI's own `/usage` command rather than a guessed HTTP
 * endpoint: `agy -p "/usage" --output-format json` returns the grouped
 * weekly / five-hour buckets for every model family, so the panel and the
 * composer badge show exactly what the CLI shows.
 */
import { deployment } from './deployment.js'

const FRESH_MS = 60_000

async function bridgeJson(credentials, path, timeoutMs = 120_000) {
  if (!deployment.quotaUrl || !deployment.quotaCredential) {
    throw new Error('quota bridge is not configured')
  }
  const credential = await credentials.resolve(deployment.quotaCredential)
  if (credential === undefined) throw new Error('quota credential is not configured')
  const response = await fetch(`${deployment.quotaUrl}${path}`, {
    headers: { authorization: `Bearer ${credential.value}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`bridge ${path} returned HTTP ${response.status}`)
  return JSON.parse(text)
}

function groupsOf(usage) {
  const groups = usage?.data?.groups ?? usage?.groups ?? []
  return groups.map((group) => ({
    name: group.name ?? group.displayName ?? 'Quota',
    description: group.description ?? '',
    windows: (Array.isArray(group.buckets) ? group.buckets : []).map((bucket) => ({
      id: bucket.id ?? bucket.window,
      window: bucket.window ?? '',
      label: bucket.name ?? bucket.window ?? '',
      note: bucket.description ?? '',
      remaining: typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction
        : typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : null,
      resetTime: bucket.reset_time ?? bucket.resetTime ?? null,
    })),
  }))
}

function pickGemini(groups) {
  return groups.find((group) => /gemini/i.test(group.name)) ?? null
}

function publicStatus(account, usage, models) {
  const groups = groupsOf(usage)
  const gemini = pickGemini(groups)
  const findWindow = (window) => gemini?.windows.find((item) => item.window === window) ?? null
  return {
    ok: true,
    account: { email: account?.email ?? null, auth: account?.auth ?? null },
    models: Array.isArray(models) ? models : [],
    groups,
    gemini: gemini === null ? null : {
      name: gemini.name,
      fiveHour: findWindow('5h'),
      weekly: findWindow('weekly'),
    },
    security: { transport: 'tunnel' },
  }
}

/** Last successful payload, with one in-flight collection at a time. */
const cache = { at: 0, payload: undefined, inFlight: undefined }

function collect(ctx) {
  if (cache.inFlight !== undefined) return cache.inFlight
  cache.inFlight = (async () => {
    try {
      const [account, usage, catalogue] = await Promise.all([
        bridgeJson(ctx.credentials, '/v1/account'),
        bridgeJson(ctx.credentials, '/v1/usage', 150_000),
        bridgeJson(ctx.credentials, '/v1/models', 90_000),
      ])
      cache.payload = publicStatus(account, usage, catalogue?.data)
      cache.at = Date.now()
      return cache.payload
    } finally {
      cache.inFlight = undefined
    }
  })()
  return cache.inFlight
}

export function applyQuota(ctx) {
  if (typeof ctx.inject !== 'function' || typeof ctx.effect !== 'function' || !ctx.tools) return
  ctx.inject(['connection'], (scoped) => scoped.effect(() => {
    const connection = scoped.connection ?? scoped.get?.('connection')
    if (typeof connection?.fetch?.register !== 'function') return undefined
    return connection.fetch.register({
      path: '/api/agy-subscription/status',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch() {
        const fresh = cache.payload !== undefined && Date.now() - cache.at < FRESH_MS
        if (fresh) return Response.json(cache.payload)
        if (cache.payload !== undefined) {
          // Stale-while-revalidate: answer now, refresh behind the panel.
          void collect(ctx).catch(() => {})
          return Response.json(cache.payload)
        }
        try {
          return Response.json(await collect(ctx))
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 502 },
          )
        }
      },
    })
  }))

  ctx.effect(() => {
    let dispose
    try {
      dispose = ctx.tools.register({
    name: 'gemini_quota',
    description: 'Report the remaining Antigravity (Google AI Pro) quota: the five-hour and weekly windows per model family, with reset times. Use it before a long Gemini task or when the user asks how much quota is left.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: value.text }] },
    },
    isConcurrencySafe() { return true },
    async execute() {
      const usage = await bridgeJson(ctx.credentials, '/v1/usage', 150_000)
      const groups = groupsOf(usage)
      if (groups.length === 0) throw new Error('gemini_quota: the CLI returned no quota groups')
      const lines = []
      for (const group of groups) {
        lines.push(group.name)
        for (const window of group.windows) {
          const percent = typeof window.remaining === 'number' ? `${(window.remaining * 100).toFixed(1)}%` : '未知'
          const reset = window.resetTime === null ? '' : `，${window.resetTime} 重置`
          lines.push(`  ${window.label}：${percent}${reset}`)
        }
      }
      return { text: lines.join('\n') }
    },
  })
    } catch (error) {
      // A reload can overlap the previous registration. Keep the adapter up;
      // the existing tool is the same quota command.
      if (!String(error?.message ?? error).includes('already registered')) throw error
    }
    return typeof dispose === 'function' ? dispose : undefined
  })
}
