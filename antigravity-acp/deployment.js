/**
 * Deployment-specific settings. Nothing in this file is a default for a
 * particular machine. Values come from the environment, then from
 * ~/.dsh/antigravity-acp.local.json, which is outside the repository.
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

const local = readLocal()

export const deployment = {
  sshHost: pick('DSH_AGY_SSH_HOST', local.sshHost),
  sshKey: pick('DSH_AGY_SSH_KEY', local.sshKey),
  mcpPort: Number(pick('DSH_AGY_MCP_PORT', local.mcpPort, '0')) || 0,
  quotaUrl: pick('DSH_AGY_QUOTA_URL', local.quotaUrl),
  quotaCredential: pick('DSH_AGY_QUOTA_CREDENTIAL', local.quotaCredential),
  clientName: pick('DSH_AGY_CLIENT_NAME', local.clientName, 'dsh'),
  screenshotDir: pick('DSH_AGY_SCREENSHOT_DIR', local.screenshotDir, join(homedir(), '.dsh', 'cache', 'screenshots')),
}

export function requireSsh() {
  if (!deployment.sshHost || !deployment.sshKey) {
    throw new Error('antigravity-acp: set sshHost and sshKey in ~/.dsh/antigravity-acp.local.json, or set DSH_AGY_SSH_HOST and DSH_AGY_SSH_KEY')
  }
}
