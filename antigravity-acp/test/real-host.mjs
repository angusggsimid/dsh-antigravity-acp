/**
 * Real-host check of the v3 lifecycle:
 *   1. two DSH sessions run concurrently (separate agy processes)
 *   2. built-in tools are gone (tools.core: []), so the model must use MCP tools
 *   3. a tool round-trip works through the reverse tunnel
 *   4. the session id persists to disk for resume
 */
import { readFileSync, rmSync } from 'node:fs'

const STORE = '/tmp/real-v3-store.json'
try { rmSync(STORE) } catch { /* fresh */ }

Object.assign(process.env, {
  DSH_AGY_MCP_PORT: '18995',
  DSH_AGY_PROMPT_TIMEOUT_MS: '240000',
  DSH_AGY_MAX_SESSIONS: '8',
  DSH_AGY_MAX_SESSIONS_HARD: '16',
  DSH_AGY_SESSION_STORE: STORE,
})
delete process.env.DSH_AGY_ACP_COMMAND
delete process.env.DSH_AGY_NO_TUNNEL

const { apply } = await import('../index.js')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const T0 = Date.now()
const at = () => `${Date.now() - T0}ms`

let adapter
let dispose
apply({
  effect(fn) { dispose = fn(); return dispose },
  get: () => undefined,
  logger: { info: (m) => console.log(`   ${at()}  ${m}`) },
  llm: { registerAdapter(_p, instance) { adapter = instance; return () => {} } },
})

const userMessage = (text) => ({ role: 'user', id: `u-${Math.random().toString(16).slice(2, 8)}`, content: [{ type: 'text', text }] })

async function runTurn({ sessionId, messages, tools = [], budgetMs = 150_000 }) {
  const out = { text: '', reasoning: '', toolCalls: [], finish: undefined, failure: undefined, firstTextAt: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    const stream = adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash',
      messages, tools, sessionId, reasoningEffort: 'low', signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') { if (out.firstTextAt === null) out.firstTextAt = Date.now() - T0; out.text += chunk.text }
      else if (chunk.type === 'reasoning-delta') out.reasoning += chunk.text
      else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.toolCalls.push(chunk.block)
      else if (chunk.type === 'finish') { out.finish = chunk.reason; if (chunk.reason?.failure) out.failure = chunk.reason.failure }
    }
  } catch (error) {
    out.failure = { message: error.message }
  } finally {
    clearTimeout(timer)
  }
  return out
}

try {
  // ---------- 1 + 2: concurrency and built-in tool removal ----------
  const [a, b] = await Promise.all([
    runTurn({ sessionId: 'v3-A', messages: [userMessage('Reply with exactly one word: ALPHA')] }),
    // Ask it to answer in prose so this measures "built-in tools are gone" rather
    // than provoking the dsh_call_tool fallback.
    runTurn({ sessionId: 'v3-B', messages: [userMessage('Do not call any tool. Answer in one short sentence: can you list the files in the current working directory yourself?')] }),
  ])
  record('two DSH sessions answered concurrently',
    /ALPHA/i.test(a.text) && b.text.length > 0,
    `A=${JSON.stringify(a.text.trim().slice(0, 20))} B=${JSON.stringify(b.text.trim().slice(0, 60))} | firstTextA=${a.firstTextAt}ms firstTextB=${b.firstTextAt}ms`)
  record('built-in tools are gone, model has no filesystem tool',
    /cannot|can't|no access|do not have|don't have|unable/i.test(b.text) && b.toolCalls.length === 0,
    `toolCalls=${JSON.stringify(b.toolCalls.map((c) => c.name))} text=${JSON.stringify(b.text.slice(0, 70))}`)

  // ---------- 3: MCP tool round trip ----------
  const tools = [{
    name: 'echo_probe',
    description: 'Echo the probe argument back to the caller.',
    parameters: { type: 'object', properties: { probe: { type: 'string' } }, required: ['probe'] },
  }]
  const messages = [userMessage('Call echo_probe once with probe="v3-ok", then report the exact value it returned.')]
  const first = await runTurn({ sessionId: 'v3-tool', messages, tools })
  const call = first.toolCalls[0]
  record('model calls the harness tool via MCP', call?.name === 'echo_probe', `toolCalls=${JSON.stringify(first.toolCalls.map((c) => c.name))} args=${call?.arguments ?? '-'}`)
  if (call) {
    const second = await runTurn({
      sessionId: 'v3-tool',
      messages: [...messages, { role: 'assistant', content: [] }, { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'v3-ok' }] }],
      tools,
    })
    record('tool result returns and the model answers', /v3-ok/i.test(second.text), `text=${JSON.stringify(second.text.trim().slice(0, 70))}`)
  }

  // ---------- 4: the session id is on disk for resume ----------
  await new Promise((r) => setTimeout(r, 600))
  let stored = {}
  try { stored = JSON.parse(readFileSync(STORE, 'utf8')) } catch { /* none */ }
  const keys = Object.keys(stored)
  record('ACP session ids are persisted for resume',
    keys.length >= 3 && keys.every((k) => stored[k]?.sessionId),
    `keys=${JSON.stringify(keys)}`)
} catch (error) {
  console.log('SUITE ERROR:', error.message)
  process.exitCode = 1
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed  (${at()} total)`)
  try { dispose?.() } catch { /* ignore */ }
  setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 500)
}
