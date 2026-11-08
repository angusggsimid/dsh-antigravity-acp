/**
 * Capacity / isolation tests: session cap, idle reclaim, cross-session refusal
 * isolation, and the hard-cap refusal message.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-capacity.log'
const PORT = 19992
try { rmSync(MOCK_LOG) } catch { /* fresh */ }
writeFileSync(MOCK_LOG, '')
try { rmSync('/tmp/mock-state-capacity.json') } catch { /* fresh */ }
try { rmSync('/tmp/plugin-store-capacity.json') } catch { /* fresh */ }

Object.assign(process.env, {
  DSH_AGY_ACP_COMMAND: `node "${fileURLToPath(new URL('./mock-agy-acp.mjs', import.meta.url))}"`,
  DSH_AGY_NO_TUNNEL: '1',
  DSH_AGY_MCP_PORT: String(PORT),
  DSH_AGY_PROMPT_TIMEOUT_MS: '20000',
  DSH_AGY_MAX_SESSIONS: '3',
  DSH_AGY_MAX_SESSIONS_HARD: '3',
  DSH_AGY_IDLE_MS: '250',
  DSH_AGY_SWEEP_MS: '80',
  MOCK_LOG,
  MOCK_STATE: '/tmp/mock-state-capacity.json',
  DSH_AGY_SESSION_STORE: '/tmp/plugin-store-capacity.json',
})

const { apply } = await import('../index.js')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

let adapter
apply({
  effect: (fn) => fn(),
  get: () => undefined,
  logger: { info() {} },
  llm: { registerAdapter(_p, instance) { adapter = instance; return () => {} } },
})

const userMessage = (text) => ({ role: 'user', id: `u-${Math.random().toString(16).slice(2, 8)}`, content: [{ type: 'text', text }] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logText = () => { try { return readFileSync(MOCK_LOG, 'utf8') } catch { return '' } }
const processCount = () => (logText().match(/\[mock-acp pid=\d+\] started/g) ?? []).length

async function runTurn(sessionId, text, budgetMs = 25_000, history = undefined) {
  const out = { text: '', failure: undefined, finish: undefined }
  try {
    const stream = adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash',
      messages: history ?? [userMessage(text)], tools: [], sessionId,
      reasoningEffort: 'medium', signal: undefined,
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
  }
  return out
}

// ------------------------------------------------- 1. refusal isolation
{
  const [builtin, plain] = await Promise.all([
    runTurn('cap-builtin', 'KW_BUILTIN list my files'),
    runTurn('cap-plain', 'just answer normally'),
  ])
  record('refusal in one session does not disturb another',
    builtin.text.includes('mock answer') && plain.text.includes('mock answer'),
    `builtin=${JSON.stringify(builtin.text.slice(0, 40))} plain=${JSON.stringify(plain.text.slice(0, 40))}`)
}

// ------------------------------------------------- 2. hard cap refusal
{
  const slow = ['cap-h1', 'cap-h2', 'cap-h3'].map((id) => runTurn(id, 'KW_SLOW:1500 hold the slot'))
  await sleep(450) // let all three claim their slots
  const overflow = await runTurn('cap-h4', 'WK_SLOW:10 one too many')
  const occupied = overflow.failure?.message ?? ''
  record('hard session cap refuses politely instead of piling on',
    /too many concurrent/i.test(occupied), `failure=${JSON.stringify(occupied.slice(0, 120))}`)
  const held = await Promise.all(slow)
  record('sessions already running are unaffected by the refusal',
    held.every((t) => t.text.includes('mock answer')),
    held.map((t) => t.text.slice(0, 22)).join(' | '))
}

// ------------------------------------------------- 3. idle reclaim
{
  await sleep(600) // let the sweeper close everything that is idle
  const warmMessages = [userMessage('warm the session')]
  const turn = await runTurn('cap-idle', 'warm the session', 25_000, warmMessages)
  const afterWarm = logText()
  const newAfterWarm = (afterWarm.match(/session\/new ->/g) ?? []).length
  const resumeAfterWarm = (afterWarm.match(/session\/resume OK/g) ?? []).length

  await sleep(700) // idle past IDLE_MS, sweeper runs
  const beforeReclaim = logText()
  const originalId = [...beforeReclaim.matchAll(/session\/new -> (\S+)/g)].pop()?.[1]
  const after = await runTurn('cap-idle', 'reuse after idle reclaim', 25_000, [
    ...warmMessages,
    { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
    userMessage('reuse after idle reclaim'),
  ])
  const final = logText()
  const newFinal = (final.match(/session\/new ->/g) ?? []).length
  const resumeFinal = (final.match(/session\/resume OK/g) ?? []).length

  // One shared front process serves every session, so the proof is not a new
  // process: it is that the reclaimed session returns via session/resume rather
  // than a fresh session/new (which would replay the transcript).
  record('idle ACP session is reclaimed and resumed without replay',
    turn.text.includes('mock answer') && after.text.includes('mock answer')
      && resumeFinal === resumeAfterWarm + 1 && newFinal === newAfterWarm,
    `resume ${resumeAfterWarm}->${resumeFinal}, session/new ${newAfterWarm}->${newFinal}`)

  // The point of resume: it must come back on the SAME ACP session, not a new one.
  const resumedId = [...final.matchAll(/session\/resume OK (\S+)/g)].pop()?.[1]
  record('resume rebinds the very same ACP session id',
    originalId !== undefined && resumedId === originalId,
    `original=${originalId} resumed=${resumedId}`)
}

// ------------------------------- 4. the A/B/C -> D eviction scenario
{
  await sleep(600) // let the sweeper clear everything so the cap math is clean
  const tag = (t) => [userMessage(`${t} first`)]

  // Three live conversations fill the soft cap (3 in this suite's env).
  await runTurn('cap-evict-A', 'A first', 25_000, tag('A'))
  await runTurn('cap-evict-B', 'B first', 25_000, tag('B'))
  await runTurn('cap-evict-C', 'C first', 25_000, tag('C'))

  const ids = [...logText().matchAll(/session\/new -> (\S+)/g)].map((m) => m[1])
  const [, idB] = ids.slice(-3) // A, B, C in creation order

  // Touch A and C so B becomes the longest-idle one.
  await runTurn('cap-evict-A', 'A second', 25_000, [...tag('A'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, userMessage('A second')])
  await runTurn('cap-evict-C', 'C second', 25_000, [...tag('C'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, userMessage('C second')])

  const beforeD = logText()
  const newBefore = (beforeD.match(/session\/new ->/g) ?? []).length
  await runTurn('cap-evict-D', 'D is brand new')
  const afterD = logText()

  record('a brand-new D evicts the longest-idle session (B)',
    afterD.includes(`session/close ${idB}`) && (afterD.match(/session\/new ->/g) ?? []).length === newBefore + 1,
    `closedB=${afterD.includes(`session/close ${idB}`)} newSessions=${newBefore}->${(afterD.match(/session\/new ->/g) ?? []).length}`)

  // D was never seen before, so it must open a fresh ACP session (an id we have
  // not seen before), rather than resuming one of A/B/C.
  const dId = [...afterD.matchAll(/session\/new -> (\S+)/g)].pop()?.[1]
  const known = new Set(ids.slice(-3))
  record('D (never seen before) gets a brand-new ACP session',
    dId !== undefined && !known.has(dId),
    `D=${dId} known=${[...known].join(',')}`)

  // Coming back to the evicted B must resume ITS OWN session, not create one.
  await runTurn('cap-evict-B', 'B is back', 25_000, [
    ...tag('B'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, userMessage('B is back'),
  ])
  const final = logText()
  const resumedB = new RegExp(`session\\/resume OK ${idB}`).test(final)
  record('returning to an evicted session resumes the SAME ACP session',
    resumedB, `expected resume of ${idB}, resumedB=${resumedB}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 300)
