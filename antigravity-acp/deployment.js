/**
 * Deployment-specific settings. Nothing in this file is a default for a
 * particular machine. Values come from the environment, then from
 * ~/.dsh/antigravity-acp.local.json, which is outside the repository.
 *
 * One file can list several routes. Each route is one DSH provider, one remote
 * host, and one Antigravity login. The chat path is the same for every route.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCAL_FILE = join(homedir(), '.dsh', 'antigravity-acp.local.json')

function readLocal() {
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function pick(envName, localValue, fallback = '') {
  const fromEnv = process.env[envName]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (localValue !== undefined && localValue !== null && String(localValue) !== '') return String(localValue)
  return fallback
}

function routeFrom(raw, index) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    id: String(source.id || (index === 0 ? 'primary' : `route-${index + 1}`)),
    provider: String(source.provider || (index === 0 ? 'antigravity' : `antigravity-${index + 1}`)),
    providerName: String(source.providerName || (index === 0 ? 'Gemini (AI Pro)' : `Gemini (AI Pro ${index + 1})`)),
    modelId: 'gemini-3.8-flash',
    modelName: String(source.modelName || 'Gemini 3.8 Flash'),
    sshHost: String(source.sshHost || ''),
    sshKey: String(source.sshKey || ''),
    mcpPort: Number((index === 0 ? process.env.DSH_AGY_MCP_PORT : '') || source.mcpPort || 0) || 0,
    home: String(source.home || '$HOME/.dsh-antigravity'),
    agent: String(source.agent || 'dsh-bridge'),
    quotaUrl: String(source.quotaUrl || ''),
    quotaCredential: String(source.quotaCredential || ''),
  }
}

const local = readLocal()

function configuredRoutes() {
  if (Array.isArray(local.routes) && local.routes.length > 0) {
    return local.routes.map((entry, index) => routeFrom(entry, index))
  }
  return [routeFrom({
    id: 'primary',
    provider: 'antigravity',
    providerName: 'Gemini (AI Pro)',
    modelName: 'Gemini 3.8 Flash',
    sshHost: pick('DSH_AGY_SSH_HOST', local.sshHost),
    sshKey: pick('DSH_AGY_SSH_KEY', local.sshKey),
    mcpPort: pick('DSH_AGY_MCP_PORT', local.mcpPort, '0'),
    home: pick('DSH_AGY_HOME', local.home, '$HOME/.dsh-antigravity'),
    quotaUrl: pick('DSH_AGY_QUOTA_URL', local.quotaUrl),
    quotaCredential: pick('DSH_AGY_QUOTA_CREDENTIAL', local.quotaCredential),
  }, 0)]
}

/** Routes that should actually start. Tests talk to one local mock. */
export function routes() {
  const all = configuredRoutes()
  const named = disambiguate(all)
  if (process.env.DSH_AGY_ACP_COMMAND) return named.slice(0, 1)
  return named
}

/** Two routes that share a model label would be indistinguishable in the picker. */
function disambiguate(list) {
  const counts = new Map()
  for (const route of list) counts.set(route.modelName, (counts.get(route.modelName) ?? 0) + 1)
  return list.map((route) => (
    counts.get(route.modelName) > 1
      ? { ...route, modelName: `${route.modelName} · ${route.providerName}` }
      : route
  ))
}

const first = configuredRoutes()[0]

export const deployment = {
  sshHost: first.sshHost,
  sshKey: first.sshKey,
  mcpPort: first.mcpPort,
  quotaUrl: first.quotaUrl,
  quotaCredential: first.quotaCredential,
  clientName: pick('DSH_AGY_CLIENT_NAME', local.clientName, 'dsh'),
  screenshotDir: pick('DSH_AGY_SCREENSHOT_DIR', local.screenshotDir, join(homedir(), '.dsh', 'cache', 'screenshots')),
}

export function requireSsh(route = first) {
  if (!route.sshHost || !route.sshKey) {
    throw new Error('antigravity-acp: each route needs sshHost and sshKey in ~/.dsh/antigravity-acp.local.json')
  }
}
