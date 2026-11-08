/**
 * Prompt-shape regression tests: what the adapter actually forwards to agy.
 *
 * The failure these lock down: DSH appends several role-`user` blocks to every
 * turn that are not the request (referenced sessions, runtime context, the skill
 * catalogue, turn timings). The adapter forwarded only the NEWEST user message —
 * which is the timing line — so agy answered "已收到技能目录与运行环境更新，请问有什么
 * 可以帮您？" instead of the question, and on a replay it was told to "answer ONLY
 * the newest user message" that was the timestamp.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-prompt.log'
const PLUGIN_STORE = '/tmp/plugin-store-prompt.json'
for (const file of [MOCK_LOG, PLUGIN_STORE]) { try { rmSync(file) } catch { /* fresh */ } }
writeFileSync(MOCK_LOG, '')

Object.assign(process.env, {
  DSH_AGY_ACP_COMMAND: `node "${fileURLToPath(new URL('./mock-agy-acp.mjs', import.meta.url))}"`,
  DSH_AGY_NO_TUNNEL: '1',
  DSH_AGY_MCP_PORT: '19997',
  DSH_AGY_PROMPT_TIMEOUT_MS: '20000',
  DSH_AGY_MAX_SESSIONS: '16',
  DSH_AGY_MAX_SESSIONS_HARD: '32',
  DSH_AGY_IDLE_MS: '600000',
  DSH_AGY_SWEEP_MS: '600000',
  MOCK_LOG,
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
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const logText = () => { try { return readFileSync(MOCK_LOG, 'utf8') } catch { return '' } }
const promptText = (from) => logText().slice(from).split('\n').filter((line) => line.includes('prompt-text')).join('\n')

async function turn(sessionId, messages) {
  const out = { text: '', finish: undefined, failure: undefined }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  try {
    const stream = adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash',
      messages, tools: [], sessionId, reasoningEffort: 'medium',
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') out.text += chunk.text
      else if (chunk.type === 'finish') out.finish = chunk.reason
    }
  } catch (error) {
    out.failure = { message: error.message }
  } finally {
    clearTimeout(timer)
  }
  return out
}

const REQUEST = '把 DSH agy 的会话继承到这个 session 并把文件迁移过来'

/** One DSH turn exactly as the host hands it over: request first, envelope after. */
const envelopeTurn = (request) => [
  user('r1', request),
  user('r2', '## Referenced sessions\n{"note":"snapshot of DSH agy"}'),
  user('r3', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
  user('r4', '<system-reminder> The available skill catalog changed. This complete catalog replaces every earlier list.'),
  user('r5', 'Time sampled while preparing turn 1, step 1: 2026-11-07T21:55:05+08:00[Asia/Hong_Kong]'),
]

// --------------------------------------- 1. a delta turn keeps the request
{
  const from = logText().length
  const first = envelopeTurn(REQUEST)
  const out = await turn('shape-A', first)
  const sent = promptText(from)
  record('the real request reaches agy', sent.includes('把 DSH agy 的会话继承到这个 session'),
    `finish=${out.finish?.kind} failure=${JSON.stringify(out.failure?.message ?? '')}`)
  record('the harness context still rides along',
    sent.includes('Referenced sessions') && sent.includes('Current runtime context'),
    'context blocks were kept')

  // Second turn on the live session: this is the DELTA path (only new blocks are
  // forwarded), which is where the envelope used to be mistaken for the request.
  const deltaFrom = logText().length
  const DELTA = 'DELTA_REQUEST 现在真的动手迁移'
  const second = await turn('shape-A', [
    ...first,
    { role: 'assistant', id: 'a0', content: [{ type: 'text', text: out.text || 'ok' }] },
    ...envelopeTurn(DELTA),
  ])
  const deltaSent = promptText(deltaFrom)
  record('a delta turn forwards the request', deltaSent.includes(DELTA), `finish=${second.finish?.kind}`)
  record('a delta turn ends with the request, not the timestamp',
    /DELTA_REQUEST 现在真的动手迁移[^|]*$/.test(deltaSent.trim()),
    `tail=${JSON.stringify(deltaSent.trim().slice(-90))}`)
}

// ---------------------- 2. the same shape on a replayed (cold) conversation
{
  const from = logText().length
  const replay = [
    user('t1', 'REAL_REQUEST_TWO 上一个问题'),
    user('t2', 'Time sampled while preparing turn 1, step 1: 2026-11-07T21:40:02+08:00'),
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] },
    user('t3', 'REAL_REQUEST_THREE 现在这个问题'),
    user('t4', 'Time sampled while preparing turn 2, step 1: 2026-11-07T21:55:05+08:00'),
  ]
  const out = await turn('shape-B', replay)
  const sent = promptText(from)
  record('a replay names the real newest request in its footer',
    /Answer ONLY the newest user message: "REAL_REQUEST_THREE/.test(sent),
    `finish=${out.finish?.kind} footer=${JSON.stringify((/Answer ONLY the newest user message: "[^"]*/.exec(sent) ?? [''])[0])}`)
  record('a replay never tells agy to answer the timestamp line',
    !/Answer ONLY the newest user message: "Time sampled/.test(sent), 'footer points at the request')
}

// ------------------------ 3. an envelope-only turn is not forwarded verbatim
{
  const from = logText().length
  const first = envelopeTurn('FIRST_REAL_REQUEST 起个头')
  await turn('shape-C', first)
  const afterFirst = logText().length
  const onlyEnvelope = [
    ...first,
    { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'ok' }] },
    user('e1', 'Time sampled while preparing turn 2, step 1: 2026-11-07T21:56:00+08:00'),
  ]
  const out = await turn('shape-C', onlyEnvelope)
  const sent = promptText(afterFirst)
  record('a turn that carries only harness context gets a real instruction',
    /Continue the task from the latest tool results above/.test(sent) || sent.includes('FIRST_REAL_REQUEST'),
    `finish=${out.finish?.kind} tail=${JSON.stringify(sent.trim().slice(-80))}`)
  record('and it is never the bare timestamp', !/Time sampled while preparing turn 2[^|]*$/.test(sent.trim()), 'no envelope tail')
  void from
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 400)
