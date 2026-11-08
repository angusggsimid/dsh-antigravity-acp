/**
 * Gemini (AI Pro) as a first-class DSH model, spoken to through the official
 * Antigravity ACP server (`agy acp`) on a remote host you configure.
 *
 * Google only ever sees the official client. This process speaks JSON-RPC over
 * an SSH stdio channel and exposes DSH tools as a loopback MCP server that the
 * remote client reaches through a reverse tunnel. Tool execution, approval,
 * and rendering stay inside DSH: an MCP call parks until the next model step
 * brings the tool result back.
 *
 * Concurrency model (v2):
 *   - one `agy acp` process PER conversation, so two DSH sessions never queue
 *     behind a single serialized turn;
 *   - one shared MCP bridge server + one shared reverse tunnel, addressed by a
 *     tenant that is stable for the conversation's whole life (a rotating
 *     tenant used to 401 in-flight tool calls);
 *   - a bounded number of live ACP sessions, idle ones evicted LRU-first.
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deployment, requireSsh, routes } from './deployment.js'
import { applyQuota } from './quota.js'

export const inject = ['llm', 'credentials', 'connection', 'tools']

/** Server name agy prefixes onto our MCP tools; anything else is one of agy's own tools. */
const MCP_SERVER = 'dsh'
/**
 * Repeated in every prompt on purpose: agy ships its own terminal and file tools,
 * and reaching for one ends the turn with nothing because this bridge refuses them.
 */
const TOOL_RULES = [
  'Hard rule: never use any built-in Antigravity tool (terminal, shell, run command, read file, write file, manage_task, list_resources, read_resource).',
  'Every tool call must be one of the harness tools listed below, by its exact name. If no tool is needed, answer in plain text.',
].join(' ')
const CONTEXT_WINDOW = Number(process.env.DSH_AGY_CONTEXT_WINDOW ?? 256_000)
/** Automatic long-decode continuations when the agent stops on `max_tokens`. */
const MAX_CONTINUATIONS = Number(process.env.DSH_AGY_CONTINUATIONS ?? 3)
const CONTINUE_PROMPT = 'Continue exactly where your previous output stopped. Do not repeat any earlier text.'
/** In-band instruction used when a rebuilt prompt would otherwise carry no user text. */
const EMPTY_INPUT_CONTINUATION = 'Continue the task from the latest tool results above.'
/** Fallback tool: invokes any harness tool by name, including ones not declared. */
const CALL_TOOL = 'dsh_call_tool'
/** Set to 0 to simulate an upstream that stopped honouring the undocumented `_meta`. */
const META_SYSTEM_PROMPT = process.env.DSH_AGY_META_SYSTEM_PROMPT !== '0'
/** Warm the ACP front at load so the first real turn does not pay process startup. */
const WARMUP = process.env.DSH_AGY_WARMUP !== '0'
const PARK_SETTLE_MS = 300
/**
 * agy caps a single MCP call at 180s and Gemini's implicit cache has an idle TTL,
 * so a long tool answers with a still-running notice before either bites.
 */
const RELAY_AFTER_MS = Number(process.env.DSH_AGY_RELAY_AFTER_MS ?? 85_000)
const AWAIT_TOOL = 'dsh_await_result'
const SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'minItems', 'maxItems', 'minLength', 'maxLength'])

/**
 * A turn that never comes back used to hang forever: `session/prompt` was issued
 * with no timer. A hard ceiling turns a silent stall into an explicit error.
 * Set DSH_AGY_PROMPT_TIMEOUT_MS=0 to disable.
 */
const PROMPT_TIMEOUT_MS = Number(process.env.DSH_AGY_PROMPT_TIMEOUT_MS ?? 0)
/**
 * A flat per-prompt deadline is wrong in both directions: it kills a healthy
 * agentic turn that is still working, and it takes minutes to notice a dead one.
 * The watchdog resets on every inbound update instead, with a much longer budget
 * while a parked tool call is outstanding (the agent is waiting on us, not lost).
 */
const IDLE_TIMEOUT_MS = Number(process.env.DSH_AGY_IDLE_TIMEOUT_MS ?? 600_000)
const WORK_IDLE_TIMEOUT_MS = Number(process.env.DSH_AGY_WORK_IDLE_TIMEOUT_MS ?? 3_600_000)
const WATCHDOG_TICK_MS = Number(process.env.DSH_AGY_WATCHDOG_TICK_MS ?? 2_000)
/** Close an ACP session that has been idle this long, freeing the remote process. */
const IDLE_MS = Number(process.env.DSH_AGY_IDLE_MS ?? 120_000)
/**
 * ACP does not stop the agent from emitting updates after the prompt response
 * ("session updates are not limited to active prompt turns"), and the
 * notification carries no prompt id. acpx solves this with a quiet drain before
 * the next prompt; we do the same, so a late tail lands in the closing turn.
 */
const QUIET_MS = Number(process.env.DSH_AGY_QUIET_MS ?? 250)
const QUIET_MAX_MS = Number(process.env.DSH_AGY_QUIET_MAX_MS ?? 2_000)
/** How often the idle sweep runs. */
const SWEEP_MS = Number(process.env.DSH_AGY_SWEEP_MS ?? 60_000)
/**
 * Beyond this many live ACP sessions, idle ones are evicted before a new one opens.
 * Each ACP session keeps its own worker, and `agy` does not reap those workers;
 * only `session/close` does. Size the cap to the remote host. The idle TTL is
 * what gives that memory back.
 */
const MAX_SOFT_SESSIONS = Number(process.env.DSH_AGY_MAX_SESSIONS ?? 3)
/** Past this, a new conversation is refused instead of piling onto the host. */
const MAX_HARD_SESSIONS = Number(process.env.DSH_AGY_MAX_SESSIONS_HARD ?? 4)
/**
 * ACP gives sessions a stable id and a `session/resume` method that reconnects to
 * an existing session WITHOUT replaying history. Persisting that id means a new
 * process (idle eviction, app restart, crash) can pick up where it left off
 * instead of re-feeding a 120k-character transcript.
 */
const RESUME = process.env.DSH_AGY_RESUME !== '0'
const CWD = process.env.DSH_AGY_CWD || ''
const SESSION_STORE = process.env.DSH_AGY_SESSION_STORE || join(homedir(), '.dsh', 'cache', 'antigravity-acp', 'sessions.json')
/**
 * Replay budget in BYTES, not characters. An unpatched `agy` truncates a single
 * USER_INPUT at 64,000 * 3 = 192,000 bytes, so a char-based 120k budget can be
 * 360KB of UTF-8 for Chinese text and get silently tail-truncated.
 */
const REPLAY_BUDGET_BYTES = Number(process.env.DSH_AGY_REPLAY_BYTES ?? 160_000)
/** How many past user messages may re-supply image blocks when replaying a transcript. */
const MAX_TRANSCRIPT_IMAGES = 3
/** ACP client identity sent in `initialize`. */
const CLIENT_NAME = deployment.clientName
/** Bridge agent name when a route does not set one. */
const AGENT_NAME = 'dsh-bridge'
/** Where MCP screenshot tools are expected to write (the mcp-playwright `cwd`). */
const SCREENSHOT_DIR = deployment.screenshotDir
/**
 * Injected once per session through `_meta.antigravity.systemPrompt.append`, which
 * gives it system-level weight instead of stuffing rules into every user turn.
 */
const SYSTEM_PREAMBLE = [
  'You are the primary model of a DeepSeek Harness (DSH) session. The harness owns the conversation, the tools, and their permissions.',
  'Every harness tool is declared to you by its exact name (`bash`, `mcp__ddg-search__search`, …). Call it by that name, with arguments exactly as its schema defines.',
  'You have no built-in terminal, shell, file, or directory tools. Never claim to have inspected the machine yourself.',
  // Pasting a screenshot as base64 "to show it" is the single worst failure mode:
  // the UI cannot render a data URI, so the user gets a wall of text instead of an
  // image. A markdown reference to an absolute path renders properly.
  'To show an image, write it to an absolute path and put `![what it shows](/absolute/path.png)` in the reply. Never paste base64 or a `data:` URI into a reply: the UI renders it as raw text.',
  // Relative paths are NOT shared between tools: the Playwright MCP server has its
  // own working directory, so `shot.png` saved through it is invisible to a tool
  // that resolves relative paths against the session workspace.
  'Relative paths are not shared between tools. A Playwright screenshot saved as `shot.png` goes to the MCP server\'s own directory (' + SCREENSHOT_DIR + ') and a harness file tool will not find it there. Save and read screenshots by absolute path.',
].join('\n')
/** Debug hook: run a local stand-in instead of `ssh … agy acp`. Test only. */
const ACP_COMMAND = process.env.DSH_AGY_ACP_COMMAND || ''
/** Debug hook: skip the reverse tunnel when the MCP peer is local. Test only. */
const NO_TUNNEL = process.env.DSH_AGY_NO_TUNNEL === '1'

/** Gemini rejects JSON-Schema-only keys, and agy drops a tool whose declaration fails. */
function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchema)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(key)) continue
    if (key === 'type') {
      const names = (Array.isArray(value) ? value : [value]).filter((entry) => typeof entry === 'string' && entry.toLowerCase() !== 'null')
      if (names.length === 0) continue
      out.type = names[0]
      if (Array.isArray(value) && names.length !== value.length) out.nullable = true
      continue
    }
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitizeSchema(child)]))
      continue
    }
    if (key === 'items') { out.items = sanitizeSchema(value); continue }
    out[key] = value
  }
  if (!out.type) out.type = 'object'
  return out
}

const sshOptions = (route) => [
  '-i', route.sshKey,
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=12',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
]

function log(ctx, message) {
  try { ctx.logger?.info?.(`[antigravity-acp] ${message}`) } catch { /* ignore */ }
}

/**
 * Metadata-only trace, written only while the marker file exists.
 * Never records prompt or answer text: kinds, lengths, tool names, stop reasons.
 */
const DIAG_MARKER = join(homedir(), '.dsh', 'cache', 'antigravity-acp', 'diag-on')
const DIAG_LOG = join(homedir(), '.dsh', 'cache', 'antigravity-acp', 'diag.jsonl')
function diag(event, fields = {}) {
  try {
    if (!existsSync(DIAG_MARKER)) return
    appendFileSync(DIAG_LOG, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n')
  } catch { /* diagnostics never break a turn */ }
}

/** Tiny persisted map: conversation key -> the ACP session it is bound to. */
class SessionStore {
  constructor(path) {
    this.path = path
    this.entries = {}
    this.saveTimer = undefined
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') this.entries = parsed
    } catch { this.entries = {} }
  }

  get(key) { return this.entries[key] }

  set(key, value) {
    this.entries[key] = { ...value, savedAt: new Date().toISOString() }
    this.#scheduleSave()
  }

  delete(key) {
    if (this.entries[key] === undefined) return
    delete this.entries[key]
    this.#scheduleSave()
  }

  #scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 250)
    this.saveTimer.unref?.()
  }

  save() {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.entries, null, 2))
      renameSync(tmp, this.path)
    } catch { /* a cache file must never break a turn */ }
  }
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
}

function toolCallIdOf(message) {
  return message?.toolCallId || message?.source?.callId || ''
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * agy names our tools `mcp_<server>_<tool>`, but a tenant-qualified or bare
 * variant can show up depending on the client build. Accept all of them.
 */
function normalizeToolName(raw) {
  const name = String(raw ?? '')
  if (name === AWAIT_TOOL || name === CALL_TOOL) return name
  if (name.startsWith(`mcp_${MCP_SERVER}_`)) {
    const rest = name.slice(`mcp_${MCP_SERVER}_`.length)
    return rest === AWAIT_TOOL.replace(/^dsh_/, '') ? AWAIT_TOOL : rest
  }
  if (name.startsWith('mcp_')) {
    const cut = name.indexOf('_', 4)
    if (cut > 0) return name.slice(cut + 1)
  }
  if (name.startsWith('dsh_')) return name.slice(4)
  return name
}

/**
 * The name the model is shown for a harness tool.
 *
 * It must be the tool's declared name exactly. Prefixing produced a third spelling
 * (`mcp_dsh_mcp__ddg-search__search`) that no model reproduces; in practice the
 * agent emitted `ddg-search__search`, the bridge could not match it, and every MCP
 * server — search, fetch, github, context7, playwright — was silently unreachable.
 */
function exposedName(name) {
  return String(name ?? '')
}

/**
 * Map a name the model actually emitted onto a registered harness tool.
 *
 * Precedence: the exact declared name, then the legacy `mcp_dsh_` spelling, then
 * an unambiguous suffix match (models drop the `mcp__<server>__` namespace). An
 * ambiguous or genuinely unknown name is returned unchanged so the harness still
 * reports it instead of dispatching to a lookalike.
 */
function resolveToolName(raw, known) {
  const name = String(raw ?? '')
  if (name === '') return name
  if (!known || known.size === 0) return normalizeToolName(name)
  if (known.has(name)) return name
  const direct = normalizeToolName(name)
  if (known.has(direct)) return direct
  const matches = []
  for (const candidate of known) {
    if (candidate.endsWith(`__${name}`) || candidate.endsWith(`_${name}`)) matches.push(candidate)
  }
  return matches.length === 1 ? matches[0] : direct
}

/** One JSON-RPC peer over `ssh … agy acp`; the reverse tunnel is owned by Runtime. */
class Link {
  constructor(ctx, runtime) {
    this.ctx = ctx
    this.runtime = runtime
    /** sessionId -> conversation, so notifications route to the owning session. */
    this.listeners = new Map()
    /** Agent version, used to gate workarounds for behaviour upstream fixed. */
    this.agentVersion = undefined
    this.child = undefined
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 0
    this.ready = undefined
    this.stderr = ''
    this.closed = false
    /** Bumped per child process, so a late exit cannot fail a newer turn. */
    this.epoch = 0
  }

  get alive() {
    return this.child !== undefined && this.child.exitCode == null
  }

  start() {
    if (this.ready) return this.ready
    // A rejected `ready` used to stick forever, bricking every later turn.
    this.ready = this.#start().catch((error) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  async #start() {
    this.closed = false
    this.buffer = ''
    // A replaced front must answer its in-flight calls: dropping the promises left
    // a turn waiting forever on a process that no longer exists.
    if (this.pending.size > 0) {
      const error = new Error('ACP process was replaced before the call completed')
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
    const epoch = ++this.epoch
    // One front process for every session. `--process-per-session` gives each ACP
    // session an isolated worker inside it, so concurrent DSH sessions no longer
    // need a separate agy process and SSH channel each.
    const flags = [
      '--process-per-session',
      '--dangerously-skip-permissions',
      '--disable-telemetry',
      ...(this.runtime?.home ? ['--gemini-dir', this.runtime.home, '--app-data-dir', 'agy'] : []),
      ...(this.runtime?.agent ? ['--agent', this.runtime.agent] : []),
    ].map((part) => (part === this.runtime?.home || part === this.runtime?.agent ? `"${part}"` : part)).join(' ')
    if (ACP_COMMAND) {
      this.child = spawn('sh', ['-c', ACP_COMMAND], { stdio: ['pipe', 'pipe', 'pipe'] })
    } else {
      const route = this.runtime.route
      requireSsh(route)
      this.child = spawn('ssh', [...sshOptions(route), '-T', route.sshHost, '--',
        `export PATH="$HOME/.local/bin:$PATH"; exec agy acp ${flags}`],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    }
    this.child.stdout.on('data', (chunk) => this.#onData(chunk.toString()))
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000) })
    this.child.on('exit', (code) => this.#onExit(code, epoch))
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: CLIENT_NAME, version: '4.0.0' },
    }, 30_000)
    const info = init?.agentInfo
    this.agentVersion = info?.version
    log(this.ctx, `ACP ready: ${info?.name ?? 'unknown'} ${info?.version ?? ''} (sessions: ${this.listeners.size})`)
    return init
  }

  #onExit(code, epoch) {
    if (epoch !== this.epoch || this.closed) return
    const error = new Error(`agy acp exited (${code ?? 'signal'}); ${this.stderr.slice(-400)}`)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.child = undefined
    this.ready = undefined
    // One front process serves them all: every session on it dies with it.
    for (const conversation of this.listeners.values()) conversation.fail(error)
    log(this.ctx, `ACP exited (${code ?? 'signal'}) with ${this.listeners.size} session(s) attached`)
  }

  /** Attach a conversation so its session's notifications route to it. */
  register(sessionId, conversation) {
    this.listeners.set(sessionId, conversation)
  }

  unregister(sessionId) {
    if (sessionId !== undefined) this.listeners.delete(sessionId)
  }

  #onData(text) {
    this.buffer += text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.method && message.id !== undefined) this.#onRequest(message)
      else if (message.method) this.#onNotification(message)
      else if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) {
          const error = new Error(message.error.message || 'ACP error')
          error.rpcCode = message.error.code
          pending.reject(error)
        }
        else pending.resolve(message.result)
      }
    }
  }

  #onNotification(message) {
    if (message.method !== 'session/update') return
    const sessionId = message.params?.sessionId
    const conversation = this.listeners.get(sessionId)
    if (conversation === undefined) {
      diag('update.unrouted', { sessionId })
      return
    }
    conversation.onUpdate(message.params?.update ?? {})
  }

  #onRequest(message) {
    if (message.method === 'session/request_permission') {
      const title = message.params?.toolCall?.title ?? message.params?.toolCall?.toolName ?? 'unknown'
      const kind = message.params?.toolCall?.kind ?? ''
      this.listeners.get(message.params?.sessionId)?.refusals.push(`permission:${kind}:${title}`)
      diag('permission.request', { title, kind, options: message.params?.options, raw: message.params?.toolCall })
      // A bare `cancelled` makes agy abandon the turn without any answer. Answering
      // with its own reject option is a refusal the agent reacts to instead.
      const reject = (message.params?.options ?? []).find((option) => String(option?.kind ?? '').startsWith('reject'))
      if (reject?.optionId !== undefined) {
        this.#reply(message.id, { outcome: { outcome: 'selected', optionId: reject.optionId } })
      } else {
        this.#reply(message.id, { outcome: { outcome: 'cancelled' } })
      }
      return
    }
    this.listeners.get(message.params?.sessionId)?.refusals.push(`request:${message.method}`)
    diag('request.unsupported', { method: message.method })
    this.#reply(message.id, undefined, { code: -32601, message: `${message.method} is not supported` })
  }

  #reply(id, result, error) {
    const payload = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }
    this.child?.stdin?.write(JSON.stringify(payload) + '\n')
  }

  request(method, params, timeoutMs = 180_000) {
    if (!this.child?.stdin) return Promise.reject(new Error('ACP process is not running'))
    const id = `c${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs) : undefined
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    try { this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') } catch { /* dead peer */ }
  }

  stop() {
    this.closed = true
    this.listeners.clear()
    try { this.child?.kill('SIGTERM') } catch { /* already gone */ }
    this.child = undefined
    this.ready = undefined
  }
}

class Conversation {
  constructor(key) {
    this.key = key
    // Stable for the conversation's whole life: rotating these used to 401
    // tool calls that were already in flight on the remote side.
    this.tenant = randomBytes(8).toString('hex')
    this.secret = randomBytes(24).toString('hex')
    this.sessionId = undefined
    this.tools = []
    /** Harness tool names for the current turn, used to un-abbreviate calls. */
    this.toolNames = new Set()
    this.toolKey = ''
    this.system = undefined
    this.model = undefined
    this.effort = undefined
    this.baseline = []
    this.generation = 0
    /**
     * Fence id for the turn that is currently allowed to deliver events. Every
     * queued event carries it, and the consumer drops events from an older one.
     * Without this, the tail the agent keeps emitting after a prompt's response
     * is read by the NEXT turn and shown as that turn's answer — which is exactly
     * the "every reply is one turn late" bug.
     */
    this.epoch = 0
    /**
     * The turn a chunk may be attributed to. Codex stamps every event with
     * `turn_context.sub_id` at emission and refuses mutations for a dead one;
     * ACP only gives us a sessionId, so the bridge records which prompt is in
     * flight and treats anything arriving after its terminal stopReason as inert.
     */
    this.activeTurn = undefined
    /** messageIds seen this turn, retired when the turn ends. */
    this.turnMessageIds = new Set()
    /** messageIds of finished turns: a chunk still carrying one is a straggler. */
    this.retiredMessageIds = new Set()
    this.watchdog = undefined
    /** Epoch of the front process this session is bound to. */
    this.linkEpoch = undefined
    this.openCalls = new Map()
    this.awaiters = new Map()
    this.ready = new Map()
    this.turn = undefined
    this.queue = []
    this.waiter = undefined
    this.text = undefined
    this.reasoning = undefined
    this.reasoningChars = 0
    this.index = 0
    this.failed = undefined
    /** agy built-in tool calls seen during the current step, for diagnostics. */
    this.builtinCalls = []
    /** Built-in tools this bridge refused during the current step. */
    this.refusals = []
    /** Outstanding session/prompt, so a cancel can be awaited before the next turn. */
    this.inflight = undefined
    /** JSON-RPC id -> payload, so a client retry of the same tools/call is not re-executed. */
    this.recent = new Map()
    /** JSON-RPC id -> parked call, so a retry can join the call already running. */
    this.openByRequest = new Map()
    /** Last agent messageId, used as the real block boundary instead of guessing. */
    this.lastMessageId = undefined
    this.streaming = false
    /** Selected but not yet streaming; protects a fresh session from eviction. */
    this.opening = false
    this.lastUsed = Date.now()
    /** Assigned by the runtime: one shared front process serves every session. */
    this.link = undefined
  }

  get busy() {
    // `opening` covers the window between conversationFor() and the first chunk:
    // without it another request could reclaim this session before it ever runs.
    return this.opening || this.streaming || this.openCalls.size > 0 || this.awaiters.size > 0 || this.ready.size > 0
  }

  fail(error) {
    this.failed = error
    this.sessionId = undefined
    this.baseline = []
    this.waiter?.reject(error)
    this.waiter = undefined
  }

  push(event) {
    let stamped = event
    if (stamped.epoch === undefined) {
      if (this.activeTurn === undefined) return
      stamped = { ...stamped, epoch: this.activeTurn }
    }
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.resolve(stamped)
    } else this.queue.push(stamped)
  }

  next(signal) {
    if (this.failed) return Promise.reject(this.failed)
    // Drop anything left over from a previous turn before handing out this one.
    while (this.queue.length > 0 && this.queue[0].epoch !== this.epoch) {
      diag('turn.stale-dropped', { epoch: this.queue[0].epoch, current: this.epoch, kind: this.queue[0].kind })
      this.queue.shift()
    }
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined
        reject(new Error('aborted'))
      }
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiter = {
        resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error) },
      }
    })
  }

  resetBlocks() {
    this.text = { index: null, text: '' }
    this.reasoning = { index: null, text: '' }
    this.reasoningChars = 0
  }

  #open(buf, kind, chunks) {
    if (buf.index !== null) return
    buf.index = this.index++
    buf.text = ''
    chunks.push({ type: 'block-start', index: buf.index, blockType: kind })
  }

  #delta(buf, kind, delta) {
    const chunks = []
    this.#open(buf, kind, chunks)
    buf.text += delta
    if (kind === 'reasoning') this.reasoningChars += delta.length
    chunks.push(kind === 'text'
      ? { type: 'text-delta', index: buf.index, text: delta }
      : { type: 'reasoning-delta', index: buf.index, text: delta })
    if (chunks.length > 0) this.push({ kind: 'chunks', chunks })
  }

  #close(buf, kind) {
    if (!buf || buf.index === null) return
    const block = kind === 'text' ? { type: 'text', text: buf.text } : { type: 'reasoning', text: buf.text }
    this.push({ kind: 'chunks', chunks: [{ type: 'block-end', index: buf.index, block }] })
    buf.index = null
    buf.text = ''
  }

  closeBlocks() {
    if (!this.text) this.resetBlocks()
    this.#close(this.reasoning, 'reasoning')
    this.#close(this.text, 'text')
  }

  onUpdate(update) {
    this.lastUpdateAt = Date.now()
    // Post-terminal straggler: the agent finished this turn but keeps dribbling.
    // Codex flips its mailbox to NextTurn here so the tail never extends an
    // answer. Drop it rather than letting the next turn adopt it.
    if (this.activeTurn === undefined) {
      diag('update.inert', { kind: update?.sessionUpdate })
      return
    }
    // ACP gives each streamed message a stable id. A chunk carrying an id from a
    // finished turn is a straggler even if a new prompt is already in flight —
    // the one case epoch alone cannot catch.
    const ownerId = update?.messageId ?? update?.message_id
    if (ownerId !== undefined) {
      if (this.retiredMessageIds.has(ownerId)) { diag('update.retired', { messageId: ownerId }); return }
      this.turnMessageIds.add(ownerId)
    }
    if (existsSync(DIAG_MARKER)) {
      const content = update?.content
      diag('update', {
        kind: update?.sessionUpdate,
        contentType: content?.type,
        textLength: typeof content?.text === 'string' ? content.text.length : undefined,
        status: update?.status,
        title: update?.title,
        mcpServer: update?.mcpServerName,
        mcpTool: update?.mcpToolName,
      })
    }
    if (!this.text) this.resetBlocks()
    // ACP can attach a stable messageId to streamed chunks. A changed id is a hard
    // message boundary, which is more reliable than inferring one from the chunk kind.
    const messageId = update.messageId ?? update.message_id
    if (messageId !== undefined && messageId !== this.lastMessageId) {
      if (this.lastMessageId !== undefined) { this.#close(this.reasoning, 'reasoning'); this.#close(this.text, 'text') }
      this.lastMessageId = messageId
    }
    const kind = update.sessionUpdate
    const content = update.content
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const name = update.mcpToolName ?? update.title ?? update.toolName ?? 'unknown'
      const server = update.mcpServerName ?? ''
      if (!String(server).startsWith(MCP_SERVER)) this.builtinCalls.push(`${name}[${update.status ?? '?'}]`)
    }
    if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && content?.type === 'text' && content.text) {
      // a cancelled turn leaks these; showing them as an answer is worse than nothing
      const leaked = content.text.trim()
      if (leaked === 'context canceled' || leaked === 'The request was cancelled by the client.') {
        diag('update.cancel-leak')
        return
      }
      const target = kind === 'agent_thought_chunk' ? 'reasoning' : 'text'
      if (target === 'reasoning') this.#close(this.text, 'text')
      else this.#close(this.reasoning, 'reasoning')
      this.#delta(this[target], target, content.text)
    }
  }

  onTool(name, args, respond, requestId) {
    // MCP forbids reusing a request id, so a repeat means the client retried after
    // a dropped stream. Replaying the first answer keeps side effects single.
    if (requestId !== undefined) {
      const cached = this.recent.get(requestId)
      if (cached !== undefined) { respond(cached); return }
      const open = this.openByRequest.get(requestId)
      if (open !== undefined) { open.extraResponders.push(respond); return }
    }
    let normalized = resolveToolName(name, this.toolNames)
    if (normalized === CALL_TOOL) {
      const target = String(args?.name ?? '')
      const inner = args?.arguments !== null && typeof args?.arguments === 'object' ? args.arguments : {}
      if (target === '' || target === CALL_TOOL) {
        respond({ content: [{ type: 'text', text: 'dsh_call_tool needs the name of a harness tool.' }], isError: true })
        return
      }
      normalized = resolveToolName(target, this.toolNames)
      args = inner
    }
    if (normalized === AWAIT_TOOL) {
      const id = String(args.call_id ?? '')
      const ready = this.ready.get(id)
      if (ready) { this.ready.delete(id); respond(ready); return }
      this.awaiters.set(id, respond)
      return
    }
    const id = `call_${randomBytes(6).toString('hex')}`
    const call = { id, name: normalized, args, respond, requestId, extraResponders: [], relayed: false }
    this.openCalls.set(id, call)
    if (requestId !== undefined) this.openByRequest.set(requestId, call)
    const timer = setTimeout(() => {
      if (!this.openCalls.has(id) || call.relayed) return
      call.relayed = true
      call.respond = undefined
      respond({
        content: [{ type: 'text', text: `Still running. Call ${AWAIT_TOOL} with call_id ${id} to collect the result. Do not call the tool again.` }],
      })
    }, RELAY_AFTER_MS)
    timer.unref?.()
    call.timer = timer
    this.#scheduleSettle()
  }

  #scheduleSettle() {
    clearTimeout(this.settle)
    this.settle = setTimeout(() => {
      const fresh = [...this.openCalls.values()].filter((call) => !call.announced && !call.relayed)
      if (fresh.length === 0) return
      for (const call of fresh) call.announced = true
      this.closeBlocks()
      this.push({ kind: 'tools', calls: fresh })
    }, PARK_SETTLE_MS)
  }

  deliverResults(results) {
    for (const result of results) {
      const call = this.openCalls.get(result.id)
      if (!call) continue
      clearTimeout(call.timer)
      const payload = { content: result.content, isError: result.isError }
      if (call.respond && !call.relayed) call.respond(payload)
      else {
        this.ready.set(result.id, payload)
        const waiter = this.awaiters.get(result.id)
        if (waiter) { this.awaiters.delete(result.id); this.ready.delete(result.id); waiter(payload) }
      }
      for (const extra of call.extraResponders ?? []) { try { extra(payload) } catch { /* gone */ } }
      if (call.requestId !== undefined) {
        this.openByRequest.delete(call.requestId)
        this.recent.set(call.requestId, payload)
        // Keep the dedupe window small: only a retry within a few hundred calls matters.
        if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value)
      }
      this.openCalls.delete(result.id)
    }
  }

  /**
   * Close every tool call that has no result yet with a synthetic result on the
   * SAME id. Codex `ensure_call_outputs_present` and Cline's message builder do
   * this; without it the next provider request is rejected for an unanswered
   * tool call.
   */
  settleStaleCalls(reason) {
    for (const call of this.openCalls.values()) {
      clearTimeout(call.timer)
      const payload = { content: [{ type: 'text', text: reason }], isError: true }
      try { if (call.respond && !call.relayed) call.respond(payload) } catch { /* gone */ }
      for (const extra of call.extraResponders ?? []) { try { extra(payload) } catch { /* gone */ } }
      if (call.requestId !== undefined) this.openByRequest.delete(call.requestId)
    }
    for (const [, respond] of this.awaiters) {
      try { respond({ content: [{ type: 'text', text: reason }], isError: true }) } catch { /* gone */ }
    }
    this.openCalls.clear()
    this.awaiters.clear()
    this.ready.clear()
    this.openByRequest.clear()
  }

  /**
   * Cancel the turn the way ACP intends: send `session/cancel`, close every
   * dangling tool call with a synthetic result on its own id, bump the
   * generation so the late `stopReason: cancelled` frame is ignored, and KEEP
   * the process and the session. Killing the child (what this used to do) throw
   * away the agent's memory and skip the mandated cancelled response.
   */
  cancelTurn() {
    this.stopWatchdog()
    clearTimeout(this.settle)
    this.settleStaleCalls('Tool execution was interrupted before a result was produced.')
    this.queue.length = 0
    this.waiter = undefined
    this.generation += 1
    this.lastMessageId = undefined
    if (this.sessionId !== undefined) this.link.notify('session/cancel', { sessionId: this.sessionId })
    this.failed = undefined
  }

  /**
   * Start a turn: never let two prompts be in flight on one ACP session, and make
   * every event buffered from the previous turn unreachable.
   */
  async beginTurn() {
    if (this.inflight) {
      // The agent is still finishing the previous turn. Ask it to stop, then wait,
      // so its tail cannot be mistaken for this turn's answer.
      if (this.sessionId !== undefined) this.link.notify('session/cancel', { sessionId: this.sessionId })
      await this.quiesce(6_000)
    }
    if (this.epoch > 0) await this.drainQuiet()
    this.epoch += 1
    this.generation += 1
    this.activeTurn = undefined
    this.turnMessageIds = new Set()
    // Drop only what provably belongs to a retired turn; a blanket clear could
    // eat the first events of a turn that starts before a straggler lands.
    this.queue = this.queue.filter((event) => event.epoch === this.epoch)
    this.waiter = undefined
    this.index = 0
    this.resetBlocks()
    this.lastMessageId = undefined
    diag('turn.begin', { epoch: this.epoch })
    return this.epoch
  }

  /**
   * Wait until the agent stops dribbling. Whatever it emits in this window is
   * charged to the turn that just ended, never to the one about to start.
   */
  async drainQuiet() {
    if (QUIET_MS <= 0) return
    // Agents from 1.5.1 on no longer emit updates after the prompt reply.
    if (agentAtLeast(this.link?.agentVersion, 1, 5, 1)) return
    const deadline = Date.now() + QUIET_MAX_MS
    while (Date.now() < deadline) {
      const quietFor = Date.now() - (this.lastUpdateAt ?? 0)
      if (quietFor >= QUIET_MS) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, QUIET_MS - quietFor)))
    }
  }

  /**
   * Fail a turn that has gone silent, without a blanket deadline: every inbound
   * update pushes the deadline out, and while a parked call is outstanding the
   * agent is waiting on the harness, so the long budget applies.
   */
  startWatchdog(epoch) {
    this.stopWatchdog()
    const tick = () => {
      if (this.epoch !== epoch || this.activeTurn !== epoch) { this.stopWatchdog(); return }
      // No point waiting out the silence budget on a process that is already gone.
      if (this.link?.alive === false) {
        this.stopWatchdog()
        diag('turn.link-dead')
        this.push({ kind: 'error', error: new Error('ACP process exited while the turn was running'), epoch })
        return
      }
      const limit = this.openCalls.size > 0 || this.awaiters.size > 0 ? WORK_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS
      const silentFor = Date.now() - (this.lastUpdateAt ?? Date.now())
      if (silentFor < limit) return
      this.stopWatchdog()
      const seconds = Math.round(limit / 1000)
      diag('turn.silent', { seconds, parked: this.openCalls.size })
      if (this.sessionId !== undefined) this.link.notify('session/cancel', { sessionId: this.sessionId })
      this.push({ kind: 'error', error: new Error(`ACP turn produced no activity for ${seconds}s`), epoch })
    }
    this.watchdog = setInterval(tick, WATCHDOG_TICK_MS)
    this.watchdog.unref?.()
  }

  stopWatchdog() {
    if (this.watchdog !== undefined) { clearInterval(this.watchdog); this.watchdog = undefined }
  }

  /** Remember which message ids belonged to the turn that just ended. */
  retireTurnMessages() {
    for (const id of this.turnMessageIds) this.retiredMessageIds.add(id)
    this.turnMessageIds = new Set()
    if (this.retiredMessageIds.size > 512) {
      const drop = [...this.retiredMessageIds].slice(0, this.retiredMessageIds.size - 512)
      for (const id of drop) this.retiredMessageIds.delete(id)
    }
  }

  /** Remember the outstanding prompt so a cancel can be awaited before the next turn. */
  trackInflight(promise) {
    const tracked = promise.then(() => {}, () => {}).then(() => {
      if (this.inflight === tracked) this.inflight = undefined
    })
    this.inflight = tracked
    return tracked
  }

  /** Wait for an interrupted turn to settle, so the next prompt is not racing it. */
  async quiesce(timeoutMs = 8_000) {
    if (!this.inflight) return
    await Promise.race([this.inflight.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /**
   * Free the session properly: `session/close` is idempotent and does not discard
   * the stored conversation, so the next turn can resume it without replaying.
   */
  async close() {
    const sessionId = this.sessionId
    this.cancelTurn()
    if (sessionId !== undefined && this.link?.alive) {
      try { await this.link.request('session/close', { sessionId }, 5_000) } catch { /* best effort */ }
    }
    // The process is shared: detach this session, never kill the front.
    this.link?.unregister(sessionId)
    this.sessionId = undefined
    this.baseline = []
  }
}

function fingerprint(tools) {
  return (tools ?? []).map((tool) => tool.name).join('\n')
}

function snapshotOf(messages) {
  return messages.map((message) => ({
    role: message.role,
    id: message.id ?? '',
    call: toolCallIdOf(message),
    text: textOf(message).slice(0, 160),
    n: Array.isArray(message.content) ? message.content.length : 0,
  }))
}

/** True when `previous` is a message-for-message prefix of `messages`. */
function samePrefix(previous, messages) {
  if (!Array.isArray(previous) || messages.length < previous.length) return false
  const current = snapshotOf(messages)
  for (let index = 0; index < previous.length; index += 1) {
    if (JSON.stringify(current[index]) !== JSON.stringify(previous[index])) return false
  }
  return true
}

function continuationResults(messages, conversation) {
  if (conversation.openCalls.size === 0 && conversation.ready.size === 0 && conversation.awaiters.size === 0) return undefined
  const wanted = new Set(conversation.openCalls.keys())
  const found = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const id = toolCallIdOf(message)
    if (!wanted.has(id)) continue
    found.push(message)
  }
  if (found.length !== wanted.size) return undefined
  return found
}

/** Keep the newest bytes of `text`, never splitting a UTF-8 sequence. */
function tailByBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let start = text.length
  let bytes = 0
  while (start > 0) {
    const code = text.charCodeAt(start - 1)
    // A low surrogate continues a 4-byte pair; count it together with its lead.
    const step = code >= 0xdc00 && code <= 0xdfff ? 2 : 1
    const slice = text.slice(start - step, start)
    const size = Buffer.byteLength(slice)
    if (bytes + size > maxBytes) break
    bytes += size
    start -= step
  }
  return text.slice(start)
}

async function blocksFromContent(content, attachments) {
  const blocks = []
  for (const block of content ?? []) {
    if (block?.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
    else if (block?.type === 'image' && !block.offloaded && attachments?.readImage) {
      try {
        const stored = await attachments.readImage(block.attachment)
        const bytes = stored?.bytes ?? stored?.data ?? stored?.content
        const mediaType = stored?.mediaType ?? block.attachment?.mediaType ?? 'image/png'
        if (bytes) blocks.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mediaType })
      } catch (error) {
        blocks.push({ type: 'text', text: `[image unreadable: ${error instanceof Error ? error.message : error}]` })
      }
    } else if (block?.type === 'image') blocks.push({ type: 'text', text: '[image omitted]' })
    else if (block?.type === 'file') blocks.push({ type: 'text', text: `[file ${block.attachment?.name ?? ''}]` })
  }
  return blocks
}

/**
 * DSH appends several role-`user` blocks to every turn that are NOT the user's
 * request: the runtime-context snapshot, the skill catalogue, the
 * referenced-session snapshot, the turn timings and model-switch notes.
 *
 * Forwarding "the newest user message" therefore handed agy the envelope, and it
 * answered "已收到技能目录与运行环境更新，请问有什么可以帮您？" instead of the
 * question. Only a message that survives these markers is a request; the rest is
 * context that must keep riding along.
 */
const INJECTED_USER_PREFIXES = [
  'Current runtime context.',
  'Time sampled while preparing turn',
  '<system-reminder>',
  '## Referenced sessions',
  '[model changed:',
  'This is an automatically generated checkpoint',
]

function isInjectedUserMessage(message) {
  const text = textOf(message).trim()
  if (text === '') {
    // An image-only or file-only message is still the user's request.
    return !(message?.content ?? []).some((block) => block?.type === 'image' || block?.type === 'file')
  }
  return INJECTED_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/** The newest user message that actually carries a request, if any. */
function latestUserRequest(messages, scope = messages) {
  for (const list of [scope, messages]) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.role === 'user' && !isInjectedUserMessage(message)) return message
    }
  }
  return undefined
}

/**
 * Replay the whole conversation as one text turn. Images from the most recent
 * user turns ride along, because a follow-up question ("what does the label in
 * that screenshot say?") is unanswerable once the earlier image becomes
 * `[image omitted]` — which is exactly what used to happen.
 */
async function renderTranscript(messages, attachments) {
  const lines = []
  for (const message of messages) {
    const body = textOf(message).trim()
    // Old transcripts may still carry a base64 payload the agent pasted before
    // the guard existed; replaying it re-teaches the wrong behaviour.
    if (message.role === 'tool') lines.push(`[tool ${toolCallIdOf(message)}]\n${sanitizeToolText(body)}`)
    else if (body) lines.push(`[${message.role}]\n${body}`)
  }
  const lastUser = latestUserRequest(messages) ?? [...messages].reverse().find((message) => message.role === 'user')
  const newest = textOf(lastUser).trim().slice(0, 120)
  const body = tailByBytes(lines.join('\n\n'), REPLAY_BUDGET_BYTES)
  // After a replay the model sees many turns at once and happily answers the most
  // interesting one. State which message is the actual request.
  const footer = newest
    ? `\n\n[The transcript above is context. Answer ONLY the newest user message: "${newest}"]`
    : ''
  const blocks = [{ type: 'text', text: (body || '(empty)') + footer }]
  const recentUsers = messages.filter((message) => message.role === 'user').slice(-MAX_TRANSCRIPT_IMAGES)
  const images = []
  for (const message of recentUsers) {
    const extra = (message.content ?? []).filter((block) => block.type !== 'text')
    if (extra.length === 0) continue
    images.push(...await blocksFromContent(extra, attachments))
  }
  const imageBlocks = images.filter((block) => block.type === 'image').slice(-MAX_TRANSCRIPT_IMAGES)
  if (imageBlocks.length > 0) blocks.push(...imageBlocks)
  return blocks
}

/**
 * Another model may answer while this ACP session is deselected. The agent never
 * saw those turns, so the history is no longer a pure extension of what it holds;
 * Codex and OpenCode restart the provider session and resend the full input
 * instead of pasting a recap into a live one.
 */
const REPLAY_FOREIGN_TURNS = process.env.DSH_AGY_REPLAY_FOREIGN_TURNS !== '0'

/** A base64 blob long enough that it can only be a file payload, not prose. */
const BASE64_RUN = /[A-Za-z0-9+/]{2000,}={0,2}/
const DATA_URI = /data:image\/[a-z0-9.+-]+;base64,/i

/**
 * Stop a binary payload from reaching the agent as text.
 *
 * A screenshot tool that returns base64 tempts the agent to paste the blob into
 * its reply "to show the image" — the UI renders that as a wall of characters,
 * not a picture, and 50 KB of base64 in the history poisons every later turn.
 * Withholding the payload and naming the one thing that does render (a markdown
 * reference to an absolute file path) makes the wrong move fail immediately and
 * visibly instead of looking like success.
 */
function sanitizeToolText(text) {
  const value = String(text ?? '')
  if (value.length < 2000) return value
  const uri = DATA_URI.test(value)
  const run = BASE64_RUN.exec(value)
  if (!uri && !run) return value
  const size = uri ? value.length : run[0].length
  return [
    `[binary payload withheld: ${size} characters of base64 image data were removed, because a reply cannot display them]`,
    'To show an image, write it to a file and reference that absolute path:',
    `  await page.screenshot({ path: '${SCREENSHOT_DIR}/page.png' })`,
    `then put ![what the image shows](${SCREENSHOT_DIR}/page.png) in the reply.`,
  ].join('\n')
}

function mcpContentOf(message) {
  const content = []
  for (const block of message.content ?? []) {
    if (block?.type === 'text') content.push({ type: 'text', text: sanitizeToolText(block.text ?? '') })
  }
  if (content.length === 0) content.push({ type: 'text', text: textOf(message) || '(empty tool result)' })
  return { id: toolCallIdOf(message), content, isError: message.isError === true }
}

/**
 * Classify a failure so DSH's retry layer can decide whether to back off. The
 * reference implementation maps to the same buckets.
 */
function mapFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  const text = message.toLowerCase()
  // -32000 is the documented "Authentication required" code; do not guess from prose.
  if (error?.rpcCode === -32000 || /authentication required/i.test(message)) {
    return { message, code: 'AUTH' }
  }
  const code = text.includes('authentication') || text.includes('unauthorized') || text.includes(' 401') ? 'AUTH'
    : text.includes('resource_exhausted') || text.includes('quota') ? 'QUOTA'
      : text.includes('rate limit') || text.includes(' 429') ? 'RATE_LIMIT'
        : text.includes('timed out') || text.includes('timeout') ? 'TIMEOUT'
          : /exited|epipe|econnreset|socket|ssh/.test(text) ? 'TRANSPORT'
            : 'SERVER'
  return { message, code }
}

/**
 * Official changelog 1.5.1: `session/update` notifications no longer arrive after
 * the prompt reply, which is the exact leak the quiet drain exists to absorb. Keep
 * the drain only for older agents so current ones do not pay the latency.
 */
function agentAtLeast(version, major, minor, patch) {
  const parts = String(version ?? '').split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length < 2 || parts.some((part) => Number.isNaN(part))) return false
  const [a = 0, b = 0, c = 0] = parts
  if (a !== major) return a > major
  if (b !== minor) return b > minor
  return c >= patch
}

function finishReason(stop) {
  if (stop === 'max_tokens' || stop === 'max_token') return { kind: 'max-tokens' }
  if (stop === 'cancelled' || stop === 'canceled') return { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } }
  return { kind: 'stop' }
}

function usageChunk(usage) {
  if (!usage) return undefined
  return {
    type: 'usage',
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cachedReadTokens ?? usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cachedWriteTokens ?? usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.thoughtTokens ?? usage.reasoningTokens ?? 0,
    },
  }
}

class Runtime {
  constructor(ctx, route) {
    this.ctx = ctx
    this.route = route
    this.conversations = new Map()
    this.tenants = new Map()
    this.locks = new Map()
    this.server = undefined
    this.port = undefined
    this.tunnel = undefined
    this.tunnelStderr = ''
    this.tunnelAttempts = 0
    this.tunnelRestart = undefined
    this.attachments = undefined
    this.sweeper = undefined
    this.ready = undefined
    this.stopping = false
    this.store = new SessionStore(SESSION_STORE)
    /** Shared `agy acp` front process. */
    this.link = undefined
    /** Isolated `--gemini-dir` and bridge agent on the remote host. */
    this.home = route.home
    this.agent = route.agent || AGENT_NAME
    this.prepared = undefined
  }

  /** Keep the original store keys for the first route so existing sessions resume. */
  persistedKey(key) {
    return this.route.id === 'primary' ? key : `${this.route.id}:${key}`
  }

  start() {
    try { this.attachments = this.ctx.get?.('attachments') } catch { this.attachments = undefined }
    // A dead tunnel must never brick the provider: the bridge still serves, turns
    // fail per session with a clear error, and the tunnel is retried in the backoff.
    this.ready = this.#bootstrap().catch((error) => {
      log(this.ctx, `bootstrap incomplete: ${error instanceof Error ? error.message : error}`)
      this.#scheduleTunnelRestart()
    })
    // Warm the front so the first real turn skips process startup.
    if (WARMUP) this.ready.then(() => this.link?.start()).catch(() => {})
    this.sweeper = setInterval(() => this.#sweep(), SWEEP_MS)
    this.sweeper.unref?.()
    return this.ready
  }

  async #bootstrap() {
    this.link = new Link(this.ctx, this)
    await this.#listen()
    await this.#ensureTunnel()
  }

  /**
   * Create the isolated home and the bridge agent on the remote host once.
   * `tools: []` plus `excludeDefaultComponents` removes every built-in tool at the
   * source, instead of relying on prompt rules or editing the user's own settings.
   * The OAuth token is copied so the official CLI stays logged in.
   */
  async #prepareRemoteHome() {
    if (ACP_COMMAND) return undefined
    if (this.prepared) return this.prepared
    this.prepared = (async () => {
      const home = this.home
      const agentDir = `${home}/config/plugins/${this.agent}/agents`
      const md = [
        '---',
        `name: ${this.agent}`,
        'description: "DeepSeek Harness primary-model bridge: no built-in tools, harness tools only"',
        'tools: []',
        'excludeDefaultComponents: true',
        'mainAgent: true',
        '---',
        '',
        // The body of an agent file IS its system prompt (verified against 1.5.3).
        // Keeping the rules here means they still apply if the undocumented
        // `_meta.antigravity.systemPrompt.append` ever stops being honoured.
        SYSTEM_PREAMBLE,
        '',
        'Act only through the harness tools you are given.',
        '',
      ].join('\n')
      const encode = (text) => Buffer.from(text, 'utf8').toString('base64')
      // Every path uses double quotes so the REMOTE shell expands $HOME; single
      // quotes produced a literal directory named "$HOME" next to the real one.
      const script = [
        `mkdir -p "${agentDir}" "${home}/agy" "${home}/workspace"`,
        `echo '${encode(JSON.stringify({ name: this.agent }, null, 2))}' | base64 -d > "${home}/config/plugins/${this.agent}/plugin.json"`,
        `echo '${encode(md)}' | base64 -d > "${agentDir}/${this.agent}.md"`,
        `for src in "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" "$HOME/.gemini/antigravity/antigravity-oauth-token"; do if [ -s "$src" ]; then cp "$src" "${home}/agy/antigravity-oauth-token"; chmod 600 "${home}/agy/antigravity-oauth-token"; break; fi; done`,
        `python3 -c 'import json,sys,pathlib; p=pathlib.Path(sys.argv[1]); d=json.loads(p.read_text()) if p.exists() else {}; d["toolPermission"]="always-proceed"; d.setdefault("agentMode",""); p.write_text(json.dumps(d,indent=2))' "${home}/agy/settings.json"`,
        'echo DSH_PREP_OK',
      ].join('\n')
      requireSsh(this.route)
      await new Promise((resolve) => {
        const child = spawn('ssh', [...sshOptions(this.route), '-T', this.route.sshHost, '--', script], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        child.stderr.on('data', (chunk) => { err = (err + chunk.toString()).slice(-600) })
        child.on('exit', (code) => {
          if (code !== 0) log(this.ctx, `remote home prep exited ${code}: ${err}`)
          resolve()
        })
      })
      log(this.ctx, `isolated home ready: ${this.home} (agent ${this.agent})`)
    })()
    return this.prepared
  }

  async #listen() {
    this.server = createServer((req, res) => { void this.#http(req, res) })
    // A tools/call parks on SSE for as long as the harness takes; Node's default
    // request/headers/keep-alive timeouts would sever it mid-tool.
    this.server.requestTimeout = 0
    this.server.headersTimeout = 0
    this.server.keepAliveTimeout = 0
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.route.mcpPort, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    }).catch(async () => {
      // Port taken: fall back to an ephemeral one rather than refusing to start.
      this.server = createServer((req, res) => { void this.#http(req, res) })
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1', resolve)
      })
    })
    this.port = this.server.address()?.port
    log(this.ctx, `MCP bridge on 127.0.0.1:${this.port}`)
  }

  /** The reverse tunnel is shared. If it dies, everything's tools die — so restart it. */
  async #ensureTunnel() {
    if (NO_TUNNEL) return
    requireSsh(this.route)
    if (this.tunnel && this.tunnel.exitCode == null) return
    this.tunnelStderr = ''
    this.tunnel = spawn('ssh', [...sshOptions(this.route), '-o', 'ExitOnForwardFailure=yes', '-N',
      '-R', `127.0.0.1:${this.port}:127.0.0.1:${this.port}`, this.route.sshHost], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.tunnel.stderr.on('data', (chunk) => { this.tunnelStderr = (this.tunnelStderr + chunk.toString()).slice(-2000) })
    this.tunnel.on('error', (error) => log(this.ctx, `reverse tunnel spawn error: ${error instanceof Error ? error.message : error}`))
    this.tunnel.on('exit', (code) => this.#onTunnelExit(code))
    await new Promise((resolve) => setTimeout(resolve, 700))
    if (this.tunnel?.exitCode != null) {
      throw new Error(`reverse tunnel failed: ${this.tunnelStderr.slice(-400)}`)
    }
  }

  #onTunnelExit(code) {
    this.tunnel = undefined
    if (this.stopping) return
    log(this.ctx, `reverse tunnel exited (${code ?? 'signal'}); ${this.tunnelStderr.slice(-300)}`)
    this.#scheduleTunnelRestart()
  }

  #scheduleTunnelRestart() {
    if (this.stopping || NO_TUNNEL) return
    this.tunnelAttempts += 1
    if (this.tunnelAttempts > 5) {
      log(this.ctx, 'reverse tunnel keeps failing; tool calls will fail until it recovers')
      return
    }
    const delay = Math.min(30_000, 1_000 * 2 ** (this.tunnelAttempts - 1))
    clearTimeout(this.tunnelRestart)
    this.tunnelRestart = setTimeout(() => {
      if (this.stopping) return
      this.#ensureTunnel().then(() => {
        this.tunnelAttempts = 0
        log(this.ctx, 'reverse tunnel restored')
      }, (error) => {
        log(this.ctx, `reverse tunnel restart failed: ${error instanceof Error ? error.message : error}`)
        this.#scheduleTunnelRestart()
      })
    }, delay)
    this.tunnelRestart.unref?.()
  }

  stop() {
    this.stopping = true
    clearInterval(this.sweeper)
    clearTimeout(this.tunnelRestart)
    for (const conversation of this.conversations.values()) conversation.close()
    this.conversations.clear()
    this.tenants.clear()
    try { this.server?.close() } catch { /* already closed */ }
    try { this.tunnel?.kill('SIGTERM') } catch { /* already gone */ }
    this.tunnel = undefined
    try { this.link?.stop() } catch { /* already gone */ }
    this.link = undefined
  }

  /** Drop ACP sessions that have been idle long enough to be worth reclaiming. */
  #sweep() {
    const now = Date.now()
    for (const [key, conversation] of this.conversations) {
      if (conversation.busy) { conversation.lastUsed = now; continue }
      if (now - conversation.lastUsed < IDLE_MS) continue
      void this.#reclaim(key, conversation, 'idle')
    }
  }

  /** Close the ACP session (so the agent frees its work) but keep the id for resume. */
  async #reclaim(key, conversation, why) {
    this.conversations.delete(key)
    this.tenants.delete(conversation.tenant)
    try { await conversation.close() } catch { /* best effort */ }
    log(this.ctx, `released ${why} ACP session ${key}; it can be resumed without replay`)
    diag('session.released', { key, why })
  }

  #evictIdle(exceptKey) {
    const idle = [...this.conversations.entries()]
      .filter(([key, conversation]) => key !== exceptKey && !conversation.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [key, conversation] of idle) {
      // #reclaim deletes synchronously before its first await, so the size is
      // already reduced when it returns.
      void this.#reclaim(key, conversation, 'capped')
      if (this.conversations.size < MAX_SOFT_SESSIONS) return
    }
  }

  async #http(req, res) {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const tenant = decodeURIComponent((req.url || '').split('/').filter(Boolean).pop() || '')
    const conversation = this.tenants.get(tenant)
    // The spec's recovery path for a session the server no longer knows is a 404
    // (client re-initializes). Answering 401 makes the client treat it as a bad
    // credential and dead-end in an auth loop.
    if (!conversation) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"unknown session"}'); return }
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!safeEqual(token, conversation.secret)) { res.writeHead(401); res.end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { res.writeHead(400); res.end(); return }
    const messages = Array.isArray(body) ? body : [body]
    const replies = []
    let parked = false
    for (const message of messages) {
      if (message.id === undefined) continue
      const method = message.method
      if (method === 'initialize') {
        replies.push({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh', version: '2.0.0' },
        } })
      } else if (method === 'tools/list') {
        const tools = [
          ...conversation.tools.map((tool) => ({
            name: tool.name,
            description: (tool.description || tool.name).slice(0, 800),
            inputSchema: sanitizeSchema(tool.parameters),
            // Without this the agent discovers tools lazily through built-in
            // helpers; eager registration keeps the harness tools first-class.
            _meta: { 'antigravity/alwaysLoad': true },
          })),
          { name: AWAIT_TOOL, description: 'Collect the result of a harness tool that said it was still running.', inputSchema: { type: 'object', properties: { call_id: { type: 'string' } }, required: ['call_id'] } },
          // Declared once so a tool added mid-session is still reachable without
          // rebuilding the session and losing the agent's prompt cache.
          { name: CALL_TOOL, description: 'Invoke any harness tool by name, including one not in your direct declarations.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] } },
        ]
        replies.push({ jsonrpc: '2.0', id: message.id, result: { tools } })
      } else if (method === 'tools/call') {
        parked = true
        const params = message.params || {}
        const respond = (result) => this.#sseResult(res, message.id, result)
        this.#sseOpen(res)
        conversation.onTool(params.name, params.arguments || {}, respond, message.id)
      } else if (method === 'ping') replies.push({ jsonrpc: '2.0', id: message.id, result: {} })
      else replies.push({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } })
    }
    if (parked) return
    if (replies.length === 0) { res.writeHead(202); res.end(); return }
    const payload = JSON.stringify(Array.isArray(body) ? replies : replies[0])
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }

  #sseOpen(res) {
    if (res.headersSent) return
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': open\n\n')
    const timer = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 10_000)
    timer.unref?.()
    res.on('close', () => clearInterval(timer))
  }

  #sseResult(res, id, result) {
    this.#sseOpen(res)
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
    res.end()
  }

  async lock(key) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    this.locks.set(key, previous.then(() => current))
    await previous
    return () => release()
  }

  conversationFor(options) {
    const key = `${options.sessionId ?? 'none'}:${options.purpose ?? 'main'}`
    let conversation = this.conversations.get(key)
    if (conversation) {
      conversation.lastUsed = Date.now()
      conversation.opening = true
      return conversation
    }
    if (this.conversations.size >= MAX_SOFT_SESSIONS) this.#evictIdle(key)
    if (this.conversations.size >= MAX_HARD_SESSIONS) {
      throw new Error(`too many concurrent Antigravity sessions (${this.conversations.size}); wait for one to finish or raise DSH_AGY_MAX_SESSIONS_HARD`)
    }
    conversation = new Conversation(key)
    conversation.link = this.link
    conversation.opening = true
    this.conversations.set(key, conversation)
    this.tenants.set(conversation.tenant, conversation)
    log(this.ctx, `opened ACP session ${key} (live: ${this.conversations.size})`)
    return conversation
  }

  /**
   * Bind the conversation to an ACP session.
   *
   * Order matters and follows the spec: reuse the live session, else `session/resume`
   * (no history replay — the agent already stores it), else `session/new` and let
   * the caller replay the transcript as a last resort.
   */
  async ensureSession(conversation, tools, { messages = [], forceNew = false, system = '' } = {}) {
    await this.#prepareRemoteHome()
    const toolKey = fingerprint(tools)
    if (conversation.sessionId && !conversation.failed) {
      conversation.toolKey = toolKey
      return
    }
    // The front was replaced since this session was bound: the ACP session still
    // exists agent-side, so drop the stale id and let session/resume re-attach
    // instead of prompting a session the new process has never heard of.
    if (conversation.sessionId !== undefined && conversation.linkEpoch !== conversation.link?.epoch) {
      diag('session.rebind', { key: conversation.key })
      conversation.sessionId = undefined
      conversation.toolKey = ''
      conversation.baseline = []
    }
    conversation.failed = undefined
    conversation.generation += 1
    conversation.queue.length = 0
    conversation.settleStaleCalls('Tool execution was interrupted before a result was produced.')
    conversation.refusals = []
    conversation.lastMessageId = undefined
    // Advertised before session/new: agy calls tools/list during the handshake.
    conversation.tools = tools ?? []
    await conversation.link.start()

    const workspace = this.workspace()
    const params = {
      cwd: workspace,
      additionalDirectories: [workspace],
      ...(META_SYSTEM_PROMPT ? { _meta: { antigravity: { systemPrompt: { append: this.#systemPrompt(system) } } } } : {}),
      mcpServers: [{
        type: 'http',
        name: 'dsh',
        url: `http://127.0.0.1:${this.port}/mcp/${conversation.tenant}`,
        headers: [{ name: 'Authorization', value: `Bearer ${conversation.secret}` }],
      }],
    }

    const saved = RESUME && !forceNew ? this.store.get(this.persistedKey(conversation.key)) : undefined
    if (saved?.sessionId) {
      try {
        await conversation.link.request('session/resume', { sessionId: saved.sessionId, ...params }, 45_000)
        const stored = Array.isArray(saved.baseline) ? saved.baseline : []
        // Only trust the resumed context when our history is still an extension of
        // what that session already saw; otherwise the transcript must be replayed
        // into a NEW session rather than stacked on top of the old one.
        if (stored.length === 0 || samePrefix(stored, messages)) {
          conversation.sessionId = saved.sessionId
          conversation.link.register(saved.sessionId, conversation)
          conversation.linkEpoch = conversation.link.epoch
          conversation.baseline = stored
          conversation.toolKey = toolKey
          conversation.model = undefined
          conversation.effort = undefined
          log(this.ctx, `resumed session ${saved.sessionId} for ${conversation.key} (no replay)`)
          diag('session.resume', { key: conversation.key })
          return
        }
        log(this.ctx, `history diverged from ${saved.sessionId}; starting a fresh session`)
        try { await conversation.link.request('session/close', { sessionId: saved.sessionId }, 5_000) } catch { /* best effort */ }
      } catch (error) {
        log(this.ctx, `resume failed for ${conversation.key}: ${error instanceof Error ? error.message : error}`)
      }
      this.store.delete(this.persistedKey(conversation.key))
    }

    conversation.baseline = []
    conversation.toolKey = toolKey
    const created = await conversation.link.request('session/new', params, 40_000)
    conversation.sessionId = created.sessionId
    conversation.link.register(created.sessionId, conversation)
    conversation.linkEpoch = conversation.link.epoch
    conversation.model = undefined
    conversation.effort = undefined
    this.store.set(this.persistedKey(conversation.key), { sessionId: created.sessionId, toolKey, baseline: [] })
    log(this.ctx, `session ${created.sessionId} for ${conversation.key}`)
    diag('session.new', { key: conversation.key })
  }

  /**
   * Describe tool-set changes in-band. The agent's declared tools are frozen at
   * session creation, so this is how it learns that the harness now offers more or
   * fewer tools without paying for a fresh session and a full replay.
   */
  toolDelta(conversation, tools) {
    const current = new Set((tools ?? []).map((tool) => tool.name))
    const declared = conversation.declared ?? new Set()
    if (declared.size === 0) { conversation.declared = current; return '' }
    const added = [...current].filter((name) => !declared.has(name))
    const removed = [...declared].filter((name) => !current.has(name))
    conversation.declared = current
    if (added.length === 0 && removed.length === 0) return ''
    const lines = ['<harness_tool_update>']
    if (added.length > 0) lines.push(`Newly available: ${added.map(exposedName).join(', ')} (or via ${CALL_TOOL} by harness name)`)
    if (removed.length > 0) lines.push(`No longer available: ${removed.join(', ')}`)
    lines.push('</harness_tool_update>')
    diag('tools.delta', { added: added.length, removed: removed.length })
    return lines.join('\n')
  }

  /** Every session runs in the isolated, empty workspace. */
  workspace() {
    if (CWD) return CWD
    return `${this.home}/workspace`
  }

  /**
   * `_meta` carries only the per-session system prompt DSH supplied; the static
   * harness rules already live in the agent body, so they are not duplicated here.
   */
  #systemPrompt(system = '') {
    return system && system.length > 0 ? system : SYSTEM_PREAMBLE
  }

  async configure(conversation, effort) {
    if (conversation.model !== this.route.modelId) {
      await conversation.link.request('session/set_config_option', { sessionId: conversation.sessionId, configId: 'model', value: this.route.modelId })
      conversation.model = this.route.modelId
    }
    const level = effort === 'low' || effort === 'high' ? effort : 'medium'
    if (conversation.effort !== level) {
      await conversation.link.request('session/set_config_option', { sessionId: conversation.sessionId, configId: 'thought_level', value: level })
      conversation.effort = level
    }
  }

  async *stream(options) {
    if (this.ready) await this.ready
    const conversation = this.conversationFor(options)
    const release = await this.lock(conversation.key)
    conversation.lastUsed = Date.now()
    conversation.streaming = true
    try {
      yield* this.#streamLocked(conversation, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.signal?.aborted || message === 'aborted') {
        conversation.cancelTurn()
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
      } else {
        conversation.lastUsed = Date.now()
        const failure = mapFailure(error)
        diag('turn.failed', { code: failure.code })
        yield { type: 'finish', reason: { kind: 'error', failure } }
      }
    } finally {
      conversation.streaming = false
      conversation.opening = false
      conversation.lastUsed = Date.now()
      release()
    }
  }

  async *#streamLocked(conversation, options) {
    const tools = options.tools ?? []
    const messages = options.messages ?? []
    const continued = continuationResults(messages, conversation)
    if (!continued) {
      // Fence the turn first: cancel anything still in flight and make every
      // buffered event from the previous turn unreachable.
      await conversation.beginTurn()
      const toolKey = fingerprint(tools)
      const live = conversation.sessionId !== undefined
      // A changed tool set no longer costs a session rebuild: the declaration list
      // stays frozen (so the agent's implicit prompt cache survives) and the delta
      // is delivered in-band, with `dsh_call_tool` as the escape hatch.
      const prefixOk = live && samePrefix(conversation.baseline, messages)
      const freshSlice = messages.slice(prefixOk ? conversation.baseline.length : 0)
      // Another model spoke while this ACP session was deselected, so the agent
      // never saw those turns. Pasting a recap into the live session leaves two
      // competing histories; Codex and OpenCode both restart the provider session
      // and resend the full input instead.
      const foreignFresh = REPLAY_FOREIGN_TURNS && freshSlice.some((message) => message?.role === 'assistant' && message.source?.provider !== undefined && message.source.provider !== this.route.provider)
      let forceNew = false
      if (live && (!prefixOk || foreignFresh)) {
        conversation.sessionId = undefined
        conversation.toolKey = ''
        conversation.baseline = []
        forceNew = true
        this.store.delete(this.persistedKey(conversation.key))
      }
      await this.ensureSession(conversation, tools, { messages, forceNew, system: options.system ?? '' })
      await this.configure(conversation, options.reasoningEffort)
    } else if (!conversation.sessionId) {
      throw new Error('tool results arrived without an Antigravity session')
    } else {
      // Same prompt, new assistant message: keep the epoch, restart the block index.
      conversation.index = 0
      // The agent is still working this prompt; keep a supervisor on it across the
      // tool hop, otherwise a dead front goes unnoticed until something else looks.
      conversation.lastUpdateAt = Date.now()
      conversation.startWatchdog(conversation.epoch)
    }
    conversation.resetBlocks()
    conversation.builtinCalls = []
    conversation.refusals = []

    if (continued) {
      conversation.deliverResults(continued.map(mcpContentOf))
    } else {
      const reusable = samePrefix(conversation.baseline, messages) && conversation.baseline.length > 0
      let prompt
      if (reusable) {
        const fresh = messages.slice(conversation.baseline.length)
        const freshUsers = fresh.filter((message) => message?.role === 'user')
        const requests = freshUsers.filter((message) => !isInjectedUserMessage(message))
        const context = freshUsers.filter((message) => isInjectedUserMessage(message))
        const blocks = []
        if (requests.length > 0) {
          // Context first, request last: a prompt that ENDED with the skill catalogue
          // or the turn timestamp was answered as "已收到技能目录与运行环境更新…".
          for (const message of [...context, ...requests]) blocks.push(...await blocksFromContent(message.content, this.attachments))
        } else {
          // No request in this turn (queued steering, a bare envelope): forward the
          // context and say what to do, instead of asking the agent to answer it.
          for (const message of freshUsers) blocks.push(...await blocksFromContent(message.content, this.attachments))
          blocks.push({ type: 'text', text: EMPTY_INPUT_CONTINUATION })
        }
        prompt = blocks
      } else {
        prompt = await renderTranscript(messages, this.attachments)
      }
      if (options.system && options.system !== conversation.system) {
        prompt = [{ type: 'text', text: options.system }, ...prompt]
        conversation.system = options.system
      }
      if (prompt.length === 0) {
        // A rules-only prompt makes the agent answer "understood, what can I help
        // with?"; send a real instruction instead of failing the turn.
        prompt = [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }]
      }
      const toolDelta = this.toolDelta(conversation, tools)
      if (toolDelta !== '') prompt = [{ type: 'text', text: toolDelta }, ...prompt]
      conversation.toolNames = new Set((tools ?? []).map((tool) => tool.name))
      const exposed = [...conversation.toolNames].map(exposedName)
      // The async await helper is advertised by tools/list too; leaving it out of
      // this list used to trap the model between "only use listed tools" and a
      // result that told it to call exactly that tool.
      exposed.push(AWAIT_TOOL, CALL_TOOL)
      // The behavioural rules now ride on the session's system prompt via
      // `_meta`; only the per-turn tool inventory still needs to be in-band.
      prompt = [{ type: 'text', text: `Available tools: ${exposed.join(', ')}.` }, ...prompt]
      conversation.baseline = snapshotOf(messages)
      this.store.set(this.persistedKey(conversation.key), { sessionId: conversation.sessionId, toolKey: conversation.toolKey, baseline: conversation.baseline })
      const generation = conversation.generation
      const epoch = conversation.epoch
      conversation.activeTurn = epoch
      conversation.lastUpdateAt = Date.now()
      conversation.startWatchdog(epoch)
      const pending = conversation.link.request('session/prompt', { sessionId: conversation.sessionId, prompt }, PROMPT_TIMEOUT_MS)
      conversation.trackInflight(pending)
      pending.then((result) => {
        if (conversation.epoch !== epoch || conversation.generation !== generation) return
        conversation.closeBlocks()
        conversation.stopWatchdog()
        conversation.push({ kind: 'done', result, epoch })
        conversation.activeTurn = undefined
        conversation.retireTurnMessages()
      }, (error) => {
        if (conversation.epoch !== epoch || conversation.generation !== generation) return
        // The previous cancel may not have unwound agent-side yet: retry the same
        // prompt once rather than surfacing a hard, confusing error.
        const text = error instanceof Error ? error.message : String(error)
        if (!collisionRetried && /foreground turn is already active|Concurrent receive_steps/i.test(text)) {
          collisionRetried = true
          diag('turn.collision-retry')
          conversation.stopWatchdog()
          conversation.activeTurn = undefined
          setTimeout(() => { try { promptAgain(prompt) } catch { /* turn moved on */ } }, 500)
          return
        }
        conversation.stopWatchdog()
        conversation.push({ kind: 'error', error, epoch })
        conversation.activeTurn = undefined
        conversation.retireTurnMessages()
      })
    }

    /** Ask the same ACP session for one more turn on the current step. */
    const promptAgain = (prompt) => {
      const generation = conversation.generation
      const epoch = conversation.epoch
      conversation.activeTurn = epoch
      conversation.lastUpdateAt = Date.now()
      conversation.startWatchdog(epoch)
      const pending = conversation.link.request('session/prompt', { sessionId: conversation.sessionId, prompt }, PROMPT_TIMEOUT_MS)
      conversation.trackInflight(pending)
      pending.then((result) => {
        if (conversation.epoch !== epoch || conversation.generation !== generation) return
        conversation.closeBlocks()
        conversation.push({ kind: 'done', result, epoch })
        conversation.activeTurn = undefined
        conversation.retireTurnMessages()
      }, (error) => {
        if (conversation.epoch !== epoch || conversation.generation !== generation) return
        conversation.push({ kind: 'error', error, epoch })
        conversation.activeTurn = undefined
        conversation.retireTurnMessages()
      })
    }

    let emitted = false
    let retried = false
    let collisionRetried = false
    let continuationBudget = MAX_CONTINUATIONS
    while (true) {
      const event = await conversation.next(options.signal)
      if (event.kind === 'chunks') {
        for (const chunk of event.chunks) {
          if (chunk.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'tool-call')) emitted = true
          yield chunk
        }
      } else if (event.kind === 'tools') {
        let index = conversation.index
        for (const call of event.calls) {
          const args = JSON.stringify(call.args ?? {})
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: args } }
          index += 1
        }
        conversation.index = index
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      } else if (event.kind === 'done') {
        if (!emitted && !retried) {
          // agy ended the turn without a single answer block, almost always because
          // the agent reached for one of its own built-in tools, which this bridge
          // refuses. Nudge it once onto the harness tools instead of showing nothing.
          const tried = [...conversation.builtinCalls, ...conversation.refusals]
          log(this.ctx, `empty turn, retrying once; tried=${tried.join(',') || 'none'}`)
          diag('turn.empty', { stopReason: event.result?.stopReason, tried, retrying: true })
          retried = true
          conversation.builtinCalls = []
          conversation.refusals = []
          conversation.resetBlocks()
          conversation.index = 0
          promptAgain([{ type: 'text', text: `${TOOL_RULES}\n\n你刚才调用了被禁用的内置工具，那一轮没有任何回答。请改用上面的工具重做这一步；不需要工具就直接用文字回答。` }])
          continue
        }
        // The agent stopped on the output cap: continue in the same ACP session
        // instead of handing the user a truncated answer.
        const stopNow = event.result?.stopReason
        if ((stopNow === 'max_tokens' || stopNow === 'max_token') && continuationBudget > 0) {
          continuationBudget -= 1
          conversation.resetBlocks()
          conversation.index = 0
          diag('turn.continue', { remaining: continuationBudget })
          promptAgain([{ type: 'text', text: CONTINUE_PROMPT }])
          continue
        }
        const usage = usageChunk(event.result?.usage)
        if (usage) yield usage
        if (!emitted) {
          // agy ended the turn without a single answer block. Never hand the user
          // an empty turn: say what the agent tried and refused.
          const stop = event.result?.stopReason ?? 'unknown'
          const tried = [...conversation.builtinCalls, ...conversation.refusals]
          log(this.ctx, `empty turn: stopReason=${stop} tried=${tried.join(',') || 'none'} reasoning=${conversation.reasoningChars}`)
          const detail = tried.length > 0
            ? `它试图使用 Antigravity 自带工具（${[...new Set(tried)].slice(0, 4).join('、')}），这些工具在本方案里被禁用。`
            : conversation.reasoningChars > 0
              ? '它只产生了内部思考，没有输出正文。'
              : '它没有产生任何可见内容。'
          const index = conversation.index
          const text = `这一轮没有输出：${detail}\n\n请重试一次；如果重复出现，把这句话发给我，我按 stopReason=${stop} 排查。`
          yield { type: 'block-start', index, blockType: 'text' }
          yield { type: 'text-delta', index, text }
          yield { type: 'block-end', index, block: { type: 'text', text } }
          conversation.index = index + 1
        }
        yield { type: 'finish', reason: finishReason(event.result?.stopReason) }
        return
      } else if (event.kind === 'error') {
        throw event.error
      }
    }
  }
}

function createAdapter(runtime) {
  const route = runtime.route
  return {
    providerInfo(provider) {
      return { id: provider, name: route.providerName }
    },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width || 1, height: image.height || 1, maxBytes: 4_000_000 }
    },
    async listModels(provider) {
      return [{
        provider,
        id: route.modelId,
        name: route.modelName,
        description: `${route.providerName} via the official Antigravity ACP server`,
        inputModalities: ['text', 'image'],
      }]
    },
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: route.modelName,
        description: `${route.providerName} via the official Antigravity ACP server`,
        inputModalities: ['text', 'image'],
        context: { contextWindow: CONTEXT_WINDOW },
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'medium',
        },
        systemPromptUpdate: 'in-history',
      }
    },
    async prepareCall(provider, model, signal) {
      const info = await this.resolveModel(provider, model, signal)
      return { model: info, stream: (options) => runtime.stream(options) }
    },
    stream(options) { return runtime.stream(options) },
  }
}

export function apply(ctx) {
  applyQuota(ctx)
  for (const route of routes()) {
    const runtime = new Runtime(ctx, route)
    ctx.effect(() => {
      runtime.start().catch((error) => log(ctx, `${route.id} startup failed: ${error instanceof Error ? error.message : error}`))
      const handle = ctx.llm.registerAdapter([route.provider], createAdapter(runtime))
      log(ctx, `registered provider ${route.provider} (${route.providerName})`)
      return () => {
        handle()
        runtime.stop()
      }
    })
  }
}
