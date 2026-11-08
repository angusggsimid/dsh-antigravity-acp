/**
 * Session lifecycle across model switches, idle reclaim and lost sessions.
 *
 * The rules under test come from the ACP spec plus how Codex/OpenCode/Cline
 * handle the same corners:
 *   A. history is a pure extension        -> same ACP session, incremental prompt
 *   B. another model spoke meanwhile      -> fresh ACP session + full replay
 *   C. session reclaimed while idle       -> session/resume, NO replay
 *   D. remote session gone                -> fresh ACP session + replay
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-switch.log'
const MOCK_STATE = '/tmp/mock-state-switch.json'
const PLUGIN_STORE = '/tmp/plugin-store-switch.json'
const PORT = 19995
for (const file of [MOCK_LOG, MOCK_STATE, PLUGIN_STORE]) {
  try { rmSync(file) } catch { /* fresh */ }
}
writeFileSync(MOCK_LOG, '')

Object.assign(process.env, {
  DSH_AGY_ACP_COMMAND: `node "${fileURLToPath(new URL('./mock-agy-acp.mjs', import.meta.url))}"`,
  DSH_AGY_NO_TUNNEL: '1',
  DSH_AGY_MCP_PORT: String(PORT),
  DSH_AGY_PROMPT_TIMEOUT_MS: '20000',
  DSH_AGY_MAX_SESSIONS: '16',
  DSH_AGY_MAX_SESSIONS_HARD: '32',
  DSH_AGY_IDLE_MS: '600',
  DSH_AGY_SWEEP_MS: '120',
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
const logText = () => { try { return readFileSync(MOCK_LOG, 'utf8') } catch { return '' } }
const count = (pattern) => (logText().match(pattern) ?? []).length
const newSessions = () => count(/session\/new ->/g)
const resumes = () => count(/session\/resume OK/g)
const promptTexts = () => [...logText().matchAll(/prompt-text session=\S+: (.+)/g)].map((m) => m[1])

const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const assistant = (text, provider) => ({ role: 'assistant', content: [{ type: 'text', text }], ...(provider ? { source: { provider } } : {}) })

async function turn(sessionId, messages) {
  const out = { text: '' }
  const stream = adapter.stream({
    provider: 'antigravity', model: 'gemini-3.8-flash',
    messages, tools: [], sessionId, reasoningEffort: 'medium', signal: undefined,
  })
  for await (const chunk of stream) if (chunk.type === 'text-delta') out.text += chunk.text
  return out
}

// ------------------------------------------------- A. pure extension
{
  const base = [user('a1', 'FIRST-A: what is a mutex')]
  await turn('switch-A', base)
  const before = newSessions()
  const beforePrompts = promptTexts().length

  await turn('switch-A', [...base, assistant('assistant note with no provider tag'), user('a2', 'SECOND-A: and a semaphore?')])
  const texts = promptTexts()
  const second = texts[beforePrompts] ?? ''

  record('pure extension keeps the same ACP session',
    newSessions() === before, `session/new ${before} -> ${newSessions()}`)
  record('and sends only the newest user message',
    second.includes('SECOND-A') && !second.includes('FIRST-A'),
    `prompt=${JSON.stringify(second.slice(-70))}`)
}

// ------------------------------------------- B. another model spoke
{
  const base = [user('b1', 'FIRST-B: hello')]
  await turn('switch-B', base)
  const before = newSessions()

  await turn('switch-B', [
    ...base,
    assistant('FOREIGN-B: answered by deepseek', 'deepseek-account'),
    user('b2', 'SECOND-B: carry on'),
  ])
  const texts = promptTexts()
  const last = texts[texts.length - 1] ?? ''

  record('a foreign model reply forces a fresh ACP session',
    newSessions() === before + 1, `session/new ${before} -> ${newSessions()}`)
  record('and the whole transcript is replayed role-faithfully',
    last.includes('FIRST-B') && last.includes('FOREIGN-B') && last.includes('SECOND-B'),
    `prompt=${JSON.stringify(last.slice(0, 110))}`)
}

// ---------------------------------- C. idle reclaim then resume
{
  const base = [user('c1', 'FIRST-C: remember this')]
  await turn('switch-C', base)
  const beforeNew = newSessions()
  const beforeResume = resumes()
  // let the sweeper reclaim it; the session itself survives on the agent side
  await sleep(1_400)

  const after = await turn('switch-C', [
    ...base,
    user('c2', 'SECOND-C: right after the reclaim'),
  ])
  const texts = promptTexts()
  const last = texts[texts.length - 1] ?? ''

  record('a reclaimed session is RESUMED, not recreated',
    resumes() === beforeResume + 1 && newSessions() === beforeNew,
    `resumes ${beforeResume} -> ${resumes()}, session/new ${beforeNew} -> ${newSessions()}`)
  record('resume does not replay the transcript',
    last.includes('SECOND-C') && !last.includes('FIRST-C'),
    `prompt=${JSON.stringify(last.slice(-70))}`)
  record('and the resumed turn still answers', after.text.includes('mock answer'), `text=${JSON.stringify(after.text.slice(0, 40))}`)
}

// ------------------------------- D. remote session is gone
{
  const base = [user('d1', 'FIRST-D: keep me')]
  await turn('switch-D', base)
  const beforeNew = newSessions()
  // the agent forgot the session (expired / swept on the remote side)
  rmSync(MOCK_STATE, { force: true })
  await sleep(1_400)

  await turn('switch-D', [...base, user('d2', 'SECOND-D: after the loss')])
  const texts = promptTexts()
  const last = texts[texts.length - 1] ?? ''

  record('a lost remote session falls back to a new session',
    newSessions() === beforeNew + 1, `session/new ${beforeNew} -> ${newSessions()}`)
  record('and replays the transcript so nothing is silently lost',
    last.includes('FIRST-D') && last.includes('SECOND-D'),
    `prompt=${JSON.stringify(last.slice(0, 110))}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 400)
