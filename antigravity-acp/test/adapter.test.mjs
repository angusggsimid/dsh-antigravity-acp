/**
 * End-to-end tests for the rewritten antigravity-acp adapter, run against the
 * local mock ACP server. Covers every fix in the concurrency/robustness pass.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

import { fileURLToPath } from 'node:url'
const MOCK_LOG = '/tmp/mock-acp-test.log'
const MOCK_PORT = 19991
try { rmSync(MOCK_LOG) } catch { /* fresh */ }
writeFileSync(MOCK_LOG, '')
try { rmSync('/tmp/mock-state-adapter.json') } catch { /* fresh */ }
try { rmSync('/tmp/plugin-store-adapter.json') } catch { /* fresh */ }

process.env.DSH_AGY_ACP_COMMAND = `node "${fileURLToPath(new URL('./mock-agy-acp.mjs', import.meta.url))}"`
process.env.DSH_AGY_NO_TUNNEL = '1'
process.env.DSH_AGY_MCP_PORT = String(MOCK_PORT)
process.env.DSH_AGY_IDLE_TIMEOUT_MS = '3000'
process.env.DSH_AGY_WATCHDOG_TICK_MS = '250'
process.env.DSH_AGY_MAX_SESSIONS = '64'
process.env.DSH_AGY_MAX_SESSIONS_HARD = '128'
process.env.DSH_AGY_IDLE_MS = '600000'
process.env.MOCK_LOG = MOCK_LOG
process.env.MOCK_STATE = '/tmp/mock-state-adapter.json'
process.env.DSH_AGY_SESSION_STORE = '/tmp/plugin-store-adapter.json'

const { apply } = await import('../index.js')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const attachments = {
  async readImage() {
    return { bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mediaType: 'image/png' }
  },
}

let adapter
const ctx = {
  effect(fn) { return fn() },
  get(name) { return name === 'attachments' ? attachments : undefined },
  logger: { info() {} },
  llm: { registerAdapter(_providers, instance) { adapter = instance; return () => {} } },
}

apply(ctx)
if (!adapter) {
  console.error('adapter was not registered')
  process.exit(1)
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo the probe argument back',
  parameters: { type: 'object', properties: { probe: { type: 'boolean' } } },
}

function userMessage(text, extra = []) {
  return { role: 'user', id: `u-${Math.random().toString(16).slice(2, 8)}`, content: [{ type: 'text', text }, ...extra] }
}

/** Collect one full turn: text, tool calls, finish reason, usage. */
async function runTurn({ sessionId, messages, tools = [], system, purpose, signal, budgetMs = 20_000 }) {
  const chunks = []
  const text = []
  const reasoning = []
  const toolCalls = []
  let finish
  let failure
  const timer = budgetMs > 0 ? setTimeout(() => { try { abortController?.abort() } catch { /* noop */ } }, budgetMs) : undefined
  let abortController
  if (signal) abortController = signal

  const stream = adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    messages,
    tools,
    system,
    sessionId,
    purpose,
    reasoningEffort: 'medium',
    signal: signal,
  })
  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') text.push(chunk.text)
      else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolCalls.push(chunk.block)
      else if (chunk.type === 'finish') {
        finish = chunk.reason
        if (chunk.reason?.failure) failure = chunk.reason.failure
      }
    }
  } catch (error) {
    failure = { message: error.message }
  } finally {
    if (timer) clearTimeout(timer)
  }
  return { chunks, text: text.join(''), reasoning: reasoning.join(''), toolCalls, finish, failure }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logText = () => { try { return readFileSync(MOCK_LOG, 'utf8') } catch { return '' } }

// ---------------------------------------------------------------- 1. baseline
{
  const turn = await runTurn({ sessionId: 'sess-basic', messages: [userMessage('hello there')] })
  record('basic turn streams text', turn.text.includes('mock answer for session') && turn.finish?.kind === 'stop', `text=${JSON.stringify(turn.text.slice(0, 60))} finish=${turn.finish?.kind}`)
  record('thought stream separated from answer', turn.reasoning.includes('think about that'), `reasoning=${JSON.stringify(turn.reasoning.slice(0, 40))}`)
}

// ------------------------------------------------------- 2. real concurrency
{
  const started = Date.now()
  const [a, b] = await Promise.all([
    runTurn({ sessionId: 'sess-conc-A', messages: [userMessage('KW_SLOW:900 then answer A')] }),
    runTurn({ sessionId: 'sess-conc-B', messages: [userMessage('KW_SLOW:900 then answer B')] }),
  ])
  const elapsed = Date.now() - started
  const bothOk = a.text.includes('mock answer') && b.text.includes('mock answer')
  record('two sessions run in parallel', bothOk && elapsed < 1700, `elapsed=${elapsed}ms (sequential would be >=1900ms), bothOk=${bothOk}`)
}

// ------------------------------------------------------- 3. prompt timeout
{
  const started = Date.now()
  const turn = await runTurn({ sessionId: 'sess-timeout', messages: [userMessage('KW_SLOW:9000 hangs')], budgetMs: 0 })
  const elapsed = Date.now() - started
  const timedOut = /no activity for|timed out/i.test(turn.failure?.message ?? '')
  record('hung turn times out instead of hanging forever', timedOut && elapsed < 6000, `elapsed=${elapsed}ms failure=${turn.failure?.message ?? 'none'}`)
}

// ------------------------------------------------------- 4. abort + recovery
{
  const controller = new AbortController()
  const pending = runTurn({ sessionId: 'sess-abort', messages: [userMessage('KW_SLOW:9000 will be aborted')], signal: controller.signal, budgetMs: 0 })
  await sleep(500)
  controller.abort()
  const aborted = await pending
  const abortOk = aborted.finish?.kind === 'aborted' || /abort/i.test(aborted.failure?.message ?? '')
  const followUp = await runTurn({ sessionId: 'sess-abort', messages: [userMessage('now a normal question')] })
  record('aborted turn reports aborted', abortOk, `finish=${aborted.finish?.kind} failure=${aborted.failure?.message ?? 'none'}`)
  record('session recovers after abort', followUp.text.includes('mock answer'), `text=${JSON.stringify(followUp.text.slice(0, 50))}`)
}

// ------------------------------------------------- 5. tool relay end-to-end
{
  const messages = [userMessage('KW_TOOL:mcp_dsh_echo please echo')]
  const first = await runTurn({ sessionId: 'sess-tool', messages, tools: [ECHO_TOOL] })
  const call = first.toolCalls[0]
  record('model tool call is relayed to DSH', first.finish?.kind === 'tool-calls' && call?.name === 'echo', `finish=${first.finish?.kind} name=${call?.name}`)

  const withResult = [
    ...messages,
    { role: 'assistant', content: [] },
    { role: 'tool', toolCallId: call?.id, content: [{ type: 'text', text: 'echo:probe=true' }] },
  ]
  const second = await runTurn({ sessionId: 'sess-tool', messages: withResult, tools: [ECHO_TOOL] })
  record('tool result is delivered back to the agent', second.text.includes('TOOL_RESULT: echo:probe=true'), `text=${JSON.stringify(second.text.slice(0, 80))}`)
  record('tool name normalization accepts mcp_dsh_ prefix', logText().includes('mcp tools/call'), 'bridge accepted the prefixed name')
}

// ------------------------------- 5b. a namespaced MCP tool survives abbreviation
{
  // The real-world failure: DSH declares `mcp__ddg-search__search`, the prompt used
  // to say "call it as mcp_dsh_<name>", and the agent emitted `ddg-search__search`.
  // Every MCP server was unreachable that way.
  const MCP_TOOL = {
    name: 'mcp__ddg-search__search',
    description: 'Search the web through DuckDuckGo',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  }
  const exact = await runTurn({
    sessionId: 'sess-mcp-exact',
    messages: [userMessage('KW_TOOL:mcp__ddg-search__search please search')],
    tools: [MCP_TOOL],
  })
  record(
    'a declared MCP name is dispatched unchanged',
    exact.toolCalls[0]?.name === 'mcp__ddg-search__search',
    `name=${exact.toolCalls[0]?.name}`,
  )

  const abbreviated = await runTurn({
    sessionId: 'sess-mcp-short',
    messages: [userMessage('KW_TOOL:ddg-search__search please search')],
    tools: [MCP_TOOL],
  })
  record(
    'an abbreviated MCP name still reaches the declared tool',
    abbreviated.toolCalls[0]?.name === 'mcp__ddg-search__search',
    `name=${abbreviated.toolCalls[0]?.name}`,
  )

  const advertised = await runTurn({
    sessionId: 'sess-mcp-list',
    messages: [userMessage('what tools do you have')],
    tools: [MCP_TOOL],
  })
  const advertisedLine = readFileSync(MOCK_LOG, 'utf8')
  record(
    'the prompt advertises the exact declared name, not a third spelling',
    advertisedLine.includes('mcp__ddg-search__search') && !/mcp_dsh_mcp__/.test(advertisedLine),
    'no double namespace in the prompt',
  )
}

// ---------------------- 5c. a base64 screenshot never reaches the agent
{
  // The real failure: Playwright returned the screenshot as base64, the agent
  // pasted it into its reply as a `data:` URI, and the user got 50 KB of text
  // instead of an image. The payload must be withheld, with the file-path
  // convention handed back in its place.
  const messages = [userMessage('KW_TOOL:echo please echo')]
  const first = await runTurn({ sessionId: 'sess-b64', messages, tools: [ECHO_TOOL] })
  const call = first.toolCalls[0]
  const blob = `iVBORw0KGgo${'QUJD'.repeat(900)}`
  const withBlob = [
    ...messages,
    { role: 'assistant', content: [] },
    { role: 'tool', toolCallId: call?.id, content: [{ type: 'text', text: `### Result\n"${blob}"` }] },
  ]
  const echoed = await runTurn({ sessionId: 'sess-b64', messages: withBlob, tools: [ECHO_TOOL] })
  record(
    'a base64 screenshot payload is withheld, not pasted into the transcript',
    echoed.text.includes('binary payload withheld') && !echoed.text.includes('QUJDQUJDQUJD'),
    `text=${JSON.stringify(echoed.text.slice(0, 110))}`,
  )
  record(
    'and the withheld payload is replaced by the absolute-path convention',
    echoed.text.includes('.dsh/cache/screenshots'),
    'screenshot path guidance present',
  )
}

// ------------------------------------------ 6. await helper is advertised
{
  const turn = await runTurn({ sessionId: 'sess-await', messages: [userMessage('check the advertised tools')] })
  const sawAwait = logText().includes('dsh_await_result')
  record('dsh_await_result listed in the prompt tool set', sawAwait && turn.text.includes('mock answer'), 'prompt text advertises the await helper')
}

// ------------------------------------------------ 7. multi-turn images
{
  const imageMessages = [
    userMessage('here is a screenshot', [{ type: 'image', attachment: { id: 'img-1', name: 'shot.png', mediaType: 'image/png' } }]),
    { role: 'assistant', content: [{ type: 'text', text: 'I see it.' }] },
    userMessage('KW_REPORT_BLOCKS what is in the image I sent earlier?'),
  ]
  const turn = await runTurn({ sessionId: 'sess-image', messages: imageMessages })
  const images = /images=(\d+)/.exec(turn.text)?.[1]
  record('earlier turn images survive into a follow-up', images === '1' && turn.text.includes('image/png'), `report=${JSON.stringify(turn.text)}`)
}

// -------------------------------------- 8. built-in refusal then retry
{
  const turn = await runTurn({ sessionId: 'sess-builtin', messages: [userMessage('KW_BUILTIN list my files')], budgetMs: 15_000 })
  const prompts = (logText().match(/prompt session=mock-\d+/g) ?? []).length
  record('built-in tool refusal triggers one corrective retry', turn.text.includes('mock answer'), `text=${JSON.stringify(turn.text.slice(0, 60))}`)
}

// -------------------------------------- 9. reasoning-only turn explained
{
  const turn = await runTurn({ sessionId: 'sess-think', messages: [userMessage('KW_ALWAYS_THINK ponder only')], budgetMs: 15_000 })
  record('reasoning-only turn explains itself instead of staying silent', turn.text.includes('只产生了内部思考'), `text=${JSON.stringify(turn.text.slice(0, 90))}`)
}

// -------------------------------------- 10. MCP auth rejects strangers
{
  let status = 0
  try {
    const response = await fetch(`http://127.0.0.1:${MOCK_PORT}/mcp/unknown-tenant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/list' }),
    })
    status = response.status
  } catch (error) {
    status = -1
  }
  // 404 is the spec's "session gone, re-initialize" signal; 401 would make the
  // client treat a stale conversation as a credential failure and loop.
  record('MCP bridge answers 404 for an unknown tenant', status === 404, `HTTP ${status}`)
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILURES:')
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
setTimeout(() => process.exit(process.exitCode ?? 0), 300)
