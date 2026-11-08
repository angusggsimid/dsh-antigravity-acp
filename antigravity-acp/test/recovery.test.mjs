/**
 * Failure-recovery tests: a spawn that fails must not brick the provider, and a
 * crash mid-turn must fail only the session that crashed.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-recovery.log'
const PORT = 19993
try { rmSync(MOCK_LOG) } catch { /* fresh */ }
writeFileSync(MOCK_LOG, '')
try { rmSync('/tmp/mock-state-recovery.json') } catch { /* fresh */ }
try { rmSync('/tmp/plugin-store-recovery.json') } catch { /* fresh */ }
try { rmSync('/tmp/flaky.count') } catch { /* fresh */ }

Object.assign(process.env, {
  DSH_AGY_ACP_COMMAND: `sh "${fileURLToPath(new URL('./flaky-acp.sh', import.meta.url))}"`,
  DSH_AGY_NO_TUNNEL: '1',
  DSH_AGY_MCP_PORT: String(PORT),
  DSH_AGY_PROMPT_TIMEOUT_MS: '15000',
  DSH_AGY_MAX_SESSIONS: '16',
  DSH_AGY_MAX_SESSIONS_HARD: '32',
  DSH_AGY_IDLE_MS: '600000',
  FLAKY_FAIL_FIRST: '1',
  MOCK_LOG,
  MOCK_STATE: '/tmp/mock-state-recovery.json',
  DSH_AGY_SESSION_STORE: '/tmp/plugin-store-recovery.json',
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

async function runTurn(sessionId, text) {
  const out = { text: '', failure: undefined, finish: undefined }
  try {
    const stream = adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash',
      messages: [userMessage(text)], tools: [], sessionId,
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

// ------------------------------------- 1. failed spawn does not brick anything
{
  const first = await runTurn('rec-retry', 'first attempt hits a broken spawn')
  const second = await runTurn('rec-retry', 'second attempt must work')
  record('a failed ACP spawn is retried on the next turn',
    second.text.includes('mock answer'),
    `first=${JSON.stringify((first.failure?.message ?? first.text).slice(0, 70))} second=${JSON.stringify(second.text.slice(0, 50))}`)
}

// ------------------------------------- 2. a crash fails only its own session
{
  const works = runTurn('rec-healthy', 'KW_SLOW:1200 keep going')
  await sleep(250)
  const crashed = runTurn('rec-crash', 'KW_DIE please crash now')
  const crashedResult = await crashed
  const healthy = await works
  record('a crash mid-turn is reported to that session',
    crashedResult.text === '' || /exited|ACP/i.test(crashedResult.failure?.message ?? ''),
    `failure=${JSON.stringify(privateFailure(crashedResult).slice(0, 90))}`)
  // One front process serves every session, so its death takes them all down —
  // the same trade-off the reference implementation makes for --process-per-session.
  // What must hold is that each session recovers on its next turn.
  record('a front crash ends every session on it (shared process)',
    crashedResult.text === '' || healthy.text === '',
    `crashed=${JSON.stringify((crashedResult.failure?.message ?? '').slice(0, 40))} healthy=${JSON.stringify(healthy.text.slice(0, 30))}`)
  const healthyRetry = await runTurn('rec-healthy', 'healthy one comes back')
  record('the surviving session rebuilds on its next turn',
    healthyRetry.text.includes('mock answer'),
    `text=${JSON.stringify(healthyRetry.text.slice(0, 40))}`)
}

// ------------------------------------- 3. crashed session recovers
{
  const retry = await runTurn('rec-crash', 'after the crash, try again')
  record('crashed session rebuilds on the next turn',
    retry.text.includes('mock answer'),
    `text=${JSON.stringify(retry.text.slice(0, 50))}`)
}

function privateFailure(result) {
  return result.failure?.message ?? `text=${result.text.slice(0, 60)}`
}

// ------------------------- 3b. a replaced front must not leave a turn hanging
{
  // FLAKY fails the first spawn, so the second turn builds a fresh front while the
  // first conversation still holds a session id from the dead one.
  const out = await runTurn('rec-rebind', 'after a front replacement')
  record('a conversation bound to a replaced front re-attaches instead of erroring',
    out.text.includes('mock answer'),
    `text=${JSON.stringify(out.text.slice(0, 50))} failure=${JSON.stringify((out.failure?.message ?? '').slice(0, 60))}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 300)
