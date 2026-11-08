/**
 * Mock Antigravity ACP server over stdio, for testing the DSH adapter without
 * touching the real host.
 *
 * Keywords in the prompt steer the behaviour:
 *   KW_SLOW:<ms>        wait before answering (lets a test abort/timeout a turn)
 *   KW_THINKONLY        emit thought chunks only, then end with no answer
 *   KW_ALWAYS_THINK     same, and every later turn of that session too
 *   KW_BUILTIN          ask permission for a built-in tool, then end with no text
 *   KW_TOOL:<name>      perform an MCP tools/call against the bridge, then answer
 *   KW_REPORT_BLOCKS    answer with the prompt's block composition
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const STATE = process.env.MOCK_STATE || '/tmp/mock-acp-state.json'
function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { sessions: {} } }
}
function saveState(state) {
  try { writeFileSync(STATE, JSON.stringify(state)) } catch { /* ignore */ }
}

const started = Date.now()
const scripts = []          // sessionId -> session/new params (+ __quiet)
const cancelled = new Set()
let nextSession = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...parts) {
  const line = `[mock-acp pid=${process.pid}] ${parts.join(' ')}`
  console.error(line)
  if (process.env.MOCK_LOG) {
    try { appendFileSync(process.env.MOCK_LOG, line + '\n') } catch { /* ignore */ }
  }
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function notify(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}

const NO_MESSAGE_ID = process.env.MOCK_NO_MESSAGE_ID === '1'

function chunkText(sessionId, kind, text, size = 24, messageId = undefined) {
  const stamp = NO_MESSAGE_ID ? undefined : messageId
  for (let index = 0; index < text.length; index += size) {
    notify(sessionId, {
      sessionUpdate: kind,
      ...(stamp === undefined ? {} : { messageId: stamp }),
      content: { type: 'text', text: text.slice(index, index + size) },
    })
  }
}

/** Minimal SSE-aware JSON-RPC POST to the loopback MCP bridge. */
async function mcpCall(url, headers, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'r1', method, params }),
  })
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('event-stream')) return response.json()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data: ')) continue
      reader.cancel().catch(() => {})
      return JSON.parse(line.slice(6))
    }
  }
  throw new Error('MCP SSE ended without a result')
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId
  const prompt = params.prompt ?? []
  const text = prompt.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  const images = prompt.filter((b) => b?.type === 'image')
  log(`prompt session=${sessionId} blocks=${prompt.length} images=${images.length} age=${Date.now() - started}ms`)
  log(`prompt-text session=${sessionId}: ${text.replace(/\n/g, ' | ').slice(0, 700)}`)

  const config = scripts[sessionId] ?? {}
  config.__turns = (config.__turns ?? 0) + 1

  if (text.includes('KW_ALWAYS_THINK')) {
    config.__quiet = true
  }

  const slow = /KW_SLOW:(\d+)/.exec(text)
  if (slow) {
    notify(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'working on the slow task' } })
    const deadline = Date.now() + Number(slow[1])
    while (Date.now() < deadline) {
      if (cancelled.has(sessionId)) {
        log(`cancelled during slow wait, session=${sessionId}`)
        send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
        return
      }
      await sleep(50)
    }
  }

  if (text.includes('KW_MAXTOKENS') && config.__turns === 1) {
    chunkText(sessionId, 'agent_message_chunk', 'PART-ONE-TRUNCATED')
    send({ jsonrpc: '2.0', id, result: { stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 6 } } })
    return
  }
  if (text.includes('Continue exactly where your previous output stopped')) {
    chunkText(sessionId, 'agent_message_chunk', 'PART-TWO-AFTER-CONTINUE')
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 6 } } })
    return
  }

  if (text.includes('KW_DIE')) {
    log(`dying on request, session=${sessionId}`)
    await sleep(100)
    process.exit(1)
  }

  if (text.includes('KW_THINKONLY') || config.__quiet === true) {
    chunkText(sessionId, 'agent_thought_chunk', 'I considered the question internally and reached no answer.')
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 7 } } })
    return
  }

  if (text.includes('KW_BUILTIN')) {
    send({
      jsonrpc: '2.0', id: `perm-${sessionId}`, method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { title: 'run_command', kind: 'execute', toolName: 'run_command' },
        options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'deny-1', kind: 'reject_once' }],
      },
    })
    await sleep(150)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  if (text.includes('KW_VIA_CALL')) {
    const server = (scripts[sessionId] ?? {}).mcpServers?.[0]
    if (!server) throw new Error('no mcp server configured for session')
    const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]))
    const call = await mcpCall(server.url, headers, 'tools/call', {
      name: 'mcp_dsh_dsh_call_tool',
      arguments: { name: 'echo', arguments: { probe: true } },
    })
    const body = (call?.result?.content ?? []).map((b) => b.text).join(' ')
    log(`mcp call_tool unwrapped -> ${body}`)
    chunkText(sessionId, 'agent_message_chunk', `VIACALL_RESULT: ${body}`)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  const tool = /KW_TOOL:([A-Za-z0-9_.-]+)/.exec(text)
  if (tool) {
    const server = config.mcpServers?.[0]
    if (!server) throw new Error('no mcp server configured for session')
    const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]))
    const list = await mcpCall(server.url, headers, 'tools/list', {})
    const names = (list?.result?.tools ?? []).map((t) => t.name)
    log(`mcp tools/list session=${sessionId} -> ${JSON.stringify(names)}`)
    const call = await mcpCall(server.url, headers, 'tools/call', { name: tool[1], arguments: { probe: true } })
    const body = (call?.result?.content ?? []).map((b) => b.text).join(' ')
    log(`mcp tools/call session=${sessionId} name=${tool[1]} -> ${body}`)
    chunkText(sessionId, 'agent_message_chunk', `TOOL_RESULT: ${body}`)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 8 } } })
    return
  }

  if (text.includes('KW_REPORT_BLOCKS')) {
    chunkText(sessionId, 'agent_message_chunk', `blocks=${prompt.length} images=${images.length} mimes=${images.map((i) => i.mimeType).join(',')}`)
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }

  const answerId = `msg-${sessionId}-${Date.now()}`
  chunkText(sessionId, 'agent_thought_chunk', 'Let me think about that briefly.', 24, `thought-${answerId}`)
  chunkText(sessionId, 'agent_message_chunk', `mock answer for session ${sessionId}`, 24, answerId)
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } } })

  // Real agents keep dribbling text after the prompt response, still tagged with the
  // message they belong to. A client without turn fencing shows it as the next answer.
  if (text.includes('KW_TRAILING')) {
    for (let index = 0; index < 3; index += 1) {
      await sleep(150)
      chunkText(sessionId, 'agent_message_chunk', ' TRAILING-LEAK-SHOULD-NOT-APPEAR', 24, answerId)
    }
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try { message = JSON.parse(trimmed) } catch { return }

  if (message.method === 'session/cancel') {
    cancelled.add(message.params?.sessionId)
    log(`session/cancel ${message.params?.sessionId}`)
    return
  }
  if (message.method === undefined && message.result !== undefined) {
    log(`client answer to our request: ${JSON.stringify(message.result)}`)
    return
  }

  const { id, method, params } = message
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { agentInfo: { name: 'Mock Antigravity ACP', version: 'test-1' }, protocolVersion: 1 } })
    return
  }
  if (method === 'session/new') {
    const sessionId = `mock-${++nextSession}-${Math.random().toString(16).slice(2, 8)}`
    scripts[sessionId] = { ...params }
    const state = loadState()
    state.sessions = state.sessions ?? {}
    state.sessions[sessionId] = { cwd: params?.cwd }
    saveState(state)
    log(`session/new -> ${sessionId} mcpServers=${JSON.stringify(params?.mcpServers ?? [])}`)
    send({ jsonrpc: '2.0', id, result: { sessionId } })
    return
  }
  if (method === 'session/resume') {
    const state = loadState()
    const resumedId = params?.sessionId
    if (state.sessions?.[resumedId] === undefined) {
      log(`session/resume REJECTED (unknown) ${resumedId}`)
      send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'unknown session' } })
      return
    }
    log(`session/resume OK ${resumedId} (no replay)`)
    send({ jsonrpc: '2.0', id, result: { sessionId: resumedId } })
    return
  }
  if (method === 'session/close') {
    log(`session/close ${params?.sessionId}`)
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'session/prompt') {
    handlePrompt(id, params).catch((error) => {
      log(`prompt failed: ${error.message}`)
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } })
    })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } })
})

log(`started`)
