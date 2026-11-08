/**
 * Feature tests for the borrowed behaviours: in-band tool deltas (no session
 * rebuild), the `dsh_call_tool` escape hatch, long-decode continuation, and
 * failure classification for the harness retry layer.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-features.log'
const MOCK_STATE = '/tmp/mock-state-features.json'
const PLUGIN_STORE = '/tmp/plugin-store-features.json'
for (const file of [MOCK_LOG, MOCK_STATE, PLUGIN_STORE]) { try { rmSync(file) } catch { /* fresh */ } }
writeFileSync(MOCK_LOG, '')

Object.assign(process.env, {
  DSH_AGY_ACP_COMMAND: `node "${fileURLToPath(new URL('./mock-agy-acp.mjs', import.meta.url))}"`,
  DSH_AGY_NO_TUNNEL: '1',
  DSH_AGY_MCP_PORT: '19994',
  DSH_AGY_PROMPT_TIMEOUT_MS: '20000',
  DSH_AGY_MAX_SESSIONS: '16',
  DSH_AGY_MAX_SESSIONS_HARD: '32',
  DSH_AGY_IDLE_MS: '600000',
  DSH_AGY_SWEEP_MS: '600000',
  DSH_AGY_CONTINUATIONS: '3',
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
const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const logText = () => { try { return readFileSync(MOCK_LOG, 'utf8') } catch { return '' } }

async function turn(sessionId, messages, { tools = [] } = {}) {
  const out = { text: '', toolCalls: [], finish: undefined, failure: undefined }
  const stream = adapter.stream({
    provider: 'antigravity', model: 'gemini-3.8-flash',
    messages, tools, sessionId, reasoningEffort: 'medium',
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.toolCalls.push(chunk.block)
    else if (chunk.type === 'finish') {
      out.finish = chunk.reason
      if (chunk.reason?.failure) out.failure = chunk.reason.failure
    }
  }
  return out
}

const TOOL_A = { name: 'alpha_tool', description: 'A', parameters: { type: 'object', properties: {} } }
const TOOL_B = { name: 'beta_tool', description: 'B', parameters: { type: 'object', properties: {} } }

// -------------------------------------------------- 1. tool delta, no rebuild
{
  const base = [user('g1', 'first question')]
  await turn('feat-delta', base, { tools: [TOOL_A] })
  const newBefore = (logText().match(/session\/new ->/g) ?? []).length

  const second = await turn('feat-delta', [...base, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('g2', 'second question')], { tools: [TOOL_A, TOOL_B] })
  const log = logText()
  const newAfter = (log.match(/session\/new ->/g) ?? []).length
  const deltaSent = /<harness_tool_update>[\s\S]*beta_tool/.test(log)

  record('a changed tool set does NOT open a new ACP session', newAfter === newBefore, `session/new ${newBefore} -> ${newAfter}`)
  record('the tool delta is delivered in-band', deltaSent, `delta=${deltaSent}`)
  record('and the turn still answers', second.text.includes('mock answer'), `text=${JSON.stringify(second.text.slice(0, 40))}`)
}

// ------------------------------------------------- 2. dsh_call_tool fallback
{
  const messages = [user('c1', 'KW_VIA_CALL please')]
  const first = await turn('feat-call', messages, { tools: [TOOL_A] })
  const call = first.toolCalls[0]
  record('dsh_call_tool unwraps to the real harness tool',
    call?.name === 'echo' && /probe/.test(call?.arguments ?? ''),
    `name=${call?.name} args=${call?.arguments}`)

  // The agent is still parked on the MCP call; hand the result back and it resumes.
  const second = await turn('feat-call', [
    ...messages,
    { role: 'assistant', content: [] },
    { role: 'tool', toolCallId: call?.id, content: [{ type: 'text', text: 'echo:probe=true' }] },
  ], { tools: [TOOL_A] })
  record('the wrapped call completes end to end', /VIACALL_RESULT/.test(second.text),
    `text=${JSON.stringify(second.text.slice(0, 70))}`)
}

// ------------------------------------------------- 3. long-decode continuation
{
  const out = await turn('feat-cont', [user('m1', 'KW_MAXTOKENS long answer')])
  record('a max_tokens stop continues in the same turn',
    out.text.includes('PART-ONE-TRUNCATED') && out.text.includes('PART-TWO-AFTER-CONTINUE') && out.finish?.kind === 'stop',
    `text=${JSON.stringify(out.text.slice(0, 70))} finish=${out.finish?.kind}`)
}

// ------------------------------------------------- 4. failure classification
{
  const out = await turn('feat-err', [user('e1', 'KW_DIE crash now')])
  record('a transport failure is classified for the retry layer',
    out.failure?.code === 'TRANSPORT', `code=${out.failure?.code} message=${JSON.stringify((out.failure?.message ?? '').slice(0, 50))}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 400)
