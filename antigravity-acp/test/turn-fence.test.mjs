/**
 * Turn fencing regression tests.
 *
 * The failure these lock down: an agent keeps streaming a tail AFTER the
 * `session/prompt` response. With one untagged FIFO that tail was read by the
 * next turn and shown as its answer, so every reply arrived one turn late.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-fence.log'
const MOCK_STATE = '/tmp/mock-state-fence.json'
const PLUGIN_STORE = '/tmp/plugin-store-fence.json'

for (const file of [MOCK_LOG, MOCK_STATE, PLUGIN_STORE]) { try { rmSync(file) } catch { /* fresh */ } }
writeFileSync(MOCK_LOG, '')

Object.assign(process.env, {
  DSH_AGY_ACP_COMMAND: `node "${fileURLToPath(new URL('./mock-agy-acp.mjs', import.meta.url))}"`,
  DSH_AGY_NO_TUNNEL: '1',
  DSH_AGY_MCP_PORT: '19996',
  DSH_AGY_PROMPT_TIMEOUT_MS: '20000',
  DSH_AGY_MAX_SESSIONS: '16',
  DSH_AGY_MAX_SESSIONS_HARD: '32',
  DSH_AGY_IDLE_MS: '600000',
  DSH_AGY_SWEEP_MS: '600000',
  MOCK_LOG,
  MOCK_STATE,
  DSH_AGY_SESSION_STORE: PLUGIN_STORE,
})

const { apply } = await import('../index.js')

let adapter
apply({
  effect: (fn) => fn(),
  get: () => undefined,
  logger: { info() {} },
  llm: { registerAdapter(_p, instance) { adapter = instance; return () => {} } },
})

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })

async function turn(sessionId, messages, { signal, budgetMs = 25_000 } = {}) {
  const out = { text: '', finish: undefined, failure: undefined }
  const timer = budgetMs > 0 ? setTimeout(() => controller.abort(), budgetMs) : undefined
  const controller = new AbortController()
  try {
    const stream = adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash',
      messages, tools: [], sessionId, reasoningEffort: 'medium',
      signal: signal ?? controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') out.text += chunk.text
      else if (chunk.type === 'finish') {
        out.finish = chunk.reason
        if (chunk.reason?.failure) out.failure = chunk.reason.failure
      }
    }
  } catch (error) {
    out.failure = { message: error.message }
  } finally {
    clearTimeout(timer)
  }
  return out
}

// ------------------------------------------------ 1. post-response tail
{
  const first = [user('f1', 'KW_TRAILING answer this one')]
  const a = await turn('fence-A', first)
  record('turn 1 answers normally', a.text.includes('mock answer'), `text=${JSON.stringify(a.text.trim().slice(0, 50))}`)

  // let the tail arrive while nothing is reading
  await sleep(900)

  const b = await turn('fence-A', [...first, { role: 'assistant', content: [{ type: 'text', text: a.text }] }, user('f2', 'now answer the second question')])
  const leaked = /TRAILING-LEAK/.test(b.text)
  record('the previous turn\'s tail does not leak into the next answer', !leaked,
    `next text=${JSON.stringify(b.text.trim().slice(0, 70))}`)
  record('and the next turn still gets its own answer', b.text.includes('mock answer'), `finish=${b.finish?.kind}`)
}

// ---------------------------- 2. interrupting a live prompt before the next one
{
  const controller = new AbortController()
  const pending = turn('fence-B', [user('g1', 'KW_SLOW:4000 this will be interrupted')], { signal: controller.signal, budgetMs: 0 })
  await sleep(600)
  controller.abort()
  const aborted = await pending
  record('an aborted turn reports aborted', aborted.finish?.kind === 'aborted', `finish=${aborted.finish?.kind}`)

  const after = await turn('fence-B', [user('g1', 'KW_SLOW:4000 this will be interrupted'), { role: 'assistant', content: [] }, user('g2', 'fresh question after the interrupt')])
  record('the turn after an interrupt answers its own question', after.text.includes('mock answer'), `text=${JSON.stringify(after.text.trim().slice(0, 60))}`)
  record('no residue from the interrupted turn', !/KW_SLOW:4000 this will be interrupted/.test(after.text), 'clean')
}

// ------------------- 2b. a straggler that lands while the NEXT turn is running
{
  const first = [user('i1', 'KW_TRAILING tail lands late')]
  const a = await turn('fence-D', first)
  record('late-tail turn answers normally', a.text.includes('mock answer'), 'ok')

  // No pause this turn: the tail arrives while turn 2's prompt is already open.
  const b = await turn('fence-D', [...first, { role: 'assistant', content: [{ type: 'text', text: a.text }] }, user('i2', 'second question right away')])
  const leaked = /TRAILING-LEAK/.test(b.text)
  record('a straggler arriving during the next turn is still discarded', !leaked,
    `next text=${JSON.stringify(b.text.trim().slice(0, 80))}`)
}

// ---- 2c. the agent omits messageId (gemini-cli does exactly this) AND the next
// turn is still streaming when the tail lands. Only the quiet drain can save us.
{
  process.env.MOCK_NO_MESSAGE_ID = '1'
  const first = [user('j1', 'KW_TRAILING no-id tail')]
  const a = await turn('fence-E', first)
  const b = await turn('fence-E', [
    ...first,
    { role: 'assistant', content: [{ type: 'text', text: a.text }] },
    user('j2', 'KW_SLOW:700 next one, slower so the tail overlaps'),
  ])
  delete process.env.MOCK_NO_MESSAGE_ID
  record('a tail without messageId cannot join an overlapping next turn', !/TRAILING-LEAK/.test(b.text),
    `next text=${JSON.stringify(b.text.trim().slice(0, 80))}`)
}

// ---------------------- 3. an empty user turn sends a real instruction instead
{
  const { readFileSync } = await import('node:fs')
  const base = [user('h1', 'first real question')]
  await turn('fence-C', base)
  const before = readFileSync(MOCK_LOG, 'utf8').length
  // Same conversation, but the newest user turn carries no text at all.
  const empty = [base[0], { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', id: 'h2', content: [] }]
  const out = await turn('fence-C', empty)
  const tail = readFileSync(MOCK_LOG, 'utf8').slice(before)
  record('an empty user turn sends a continuation instruction, not a rules-only prompt',
    /Continue the task from the latest tool results above/.test(tail) && out.text.includes('mock answer'),
    `failure=${JSON.stringify(out.failure?.message ?? '')} text=${JSON.stringify(out.text.slice(0, 40))}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 400)
