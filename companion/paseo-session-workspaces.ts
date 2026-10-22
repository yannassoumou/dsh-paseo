/**
 * Attach Paseo-started DSH sessions to DSH Workspaces.
 *
 * Paseo agents run through `dsh --profile acp`, and each agent owns one durable DSH Session.
 * These sessions appear in DSH session lists but fall into the Ungrouped bucket because nothing
 * creates a Workspace for their cwd. This plugin watches the Paseo daemon's agent records under
 * `$PASEO_HOME/agents` (one JSON file per agent), maps each record to its DSH Session (via the
 * persistence handle Paseo stores), and creates or reuses the Workspace for the agent's cwd so
 * every Paseo session lands under its project workspace in the DSH workspace browser — with the
 * trajectory, search, and history features available for each one.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'paseo-session-workspaces'
export const inject = ['workspaceRegistry', 'timer']

export interface Config {
  /** Paseo daemon home; default `~/.paseo`. */
  paseoHome?: string
  /** Provider ids whose agent records are mapped; default `["dsh"]`. */
  enabledProviders?: readonly string[]
  /** Scan interval in milliseconds; default 5000. */
  scanIntervalMs?: number
}

interface PaseoAgentRecord {
  id: string
  provider?: string
  cwd?: string
  title?: string
  workspaceId?: string
  persistence?: { provider?: string; sessionId?: string }
}

interface PaseoWorkspaceMeta {
  cwd?: string
  projectId?: string
  displayName?: string
  branch?: string
  isPaseoOwnedWorktree?: boolean
  updatedAt?: string
}

interface PaseoProjectMeta {
  projectId?: string
  displayName?: string
  rootPath?: string
}

/** Extract the DSH Session id from a Paseo persistence handle (`plugin:{"data":{"sessionId":…}}`). */
function parseDshSessionId(record: PaseoAgentRecord): string | undefined {
  const raw = record.persistence?.sessionId
  if (typeof raw !== 'string' || !raw.startsWith('plugin:')) return undefined
  try {
    const decoded = JSON.parse(raw.slice('plugin:'.length)) as { data?: { sessionId?: unknown } }
    const sessionId = decoded?.data?.sessionId
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  } catch {
    return undefined
  }
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * A human label for the workspace: Paseo's project name when the cwd belongs to a known
 * Paseo workspace (worktrees read as `project/branch-or-folder`), otherwise the directory
 * basename.
 */
function workspaceTitleFor(
  cwd: string,
  agent: PaseoAgentRecord,
  workspaces: readonly PaseoWorkspaceMeta[],
  projects: readonly PaseoProjectMeta[],
): string {
  const match = workspaces
    .filter((workspace) => workspace.cwd === cwd)
    .sort((left, right) => (left.updatedAt ?? '').localeCompare(right.updatedAt ?? ''))
    .at(-1)
  const project = match?.projectId !== undefined
    ? projects.find((candidate) => candidate.projectId === match.projectId)
    : projects.find((candidate) => candidate.rootPath !== undefined && cwd.startsWith(`${candidate.rootPath}/`))
  const projectName = project?.displayName
  if (projectName === undefined || projectName === '') return basename(cwd)
  if (match?.isPaseoOwnedWorktree === true) {
    const detail = match.branch ?? match.displayName ?? basename(cwd)
    return `${projectName} · ${detail}`
  }
  return projectName
}

export function apply(ctx: Context, config: Config = {}): void {
  const paseoHome = config.paseoHome ?? join(homedir(), '.paseo')
  const agentsRoot = join(paseoHome, 'agents')
  const enabled = new Set(config.enabledProviders ?? ['dsh'])
  const scanIntervalMs = Math.max(1_000, config.scanIntervalMs ?? 5_000)
  if (!existsSync(agentsRoot)) {
    ctx.logger.warn(`paseo-session-workspaces: no Paseo agents directory at ${agentsRoot}`)
    return
  }

  // Debug trail: the host's stderr is not always reachable (e.g. `pnpm dsh web` in a terminal),
  // and silent attach failures were indistinguishable from permanent success. One line per event.
  const debugLog = join(homedir(), '.local', 'state', 'dsh-paseo', 'companion.log')
  const note = (message: string): void => {
    try {
      mkdirSync(join(debugLog, '..'), { recursive: true })
      appendFileSync(debugLog, `${new Date().toISOString()} ${message}\n`)
    } catch {
      /* diagnostics must never break the scan */
    }
  }

  const attached = new Set<string>()
  const warned = new Set<string>()
  let scanning = false
  const scan = async (): Promise<void> => {
    if (scanning) return
    scanning = true
    try {
      const agents: PaseoAgentRecord[] = []
      for (const slug of readdirSync(agentsRoot)) {
        const directory = join(agentsRoot, slug)
        let entries: string[]
        try {
          if (!statSync(directory).isDirectory()) continue
          entries = readdirSync(directory)
        } catch {
          continue
        }
        for (const file of entries) {
          if (!file.endsWith('.json')) continue
          const record = readJsonSafe(join(directory, file)) as PaseoAgentRecord | undefined
          if (record && typeof record.id === 'string') agents.push(record)
        }
      }
      if (agents.length === 0) return
      const workspaces = asArray<PaseoWorkspaceMeta>(readJsonSafe(join(paseoHome, 'projects', 'workspaces.json')))
      const projects = asArray<PaseoProjectMeta>(readJsonSafe(join(paseoHome, 'projects', 'projects.json')))

      for (const agent of agents) {
        if (attached.has(agent.id)) continue
        if (agent.provider === undefined || !enabled.has(agent.provider)) continue
        if (agent.cwd === undefined || agent.title === undefined || agent.title === '') continue
        const sessionId = parseDshSessionId(agent)
        if (sessionId === undefined) continue
        let workspacePath: string
        try {
          if (!statSync(agent.cwd).isDirectory()) {
            // The worktree is currently absent: Paseo prunes worktrees after archiving and may
            // restore them later, and it writes the agent record in the same second it creates a
            // fresh worktree. Skip without blacklisting so later scans can attach.
            continue
          }
          workspacePath = agent.cwd
        } catch {
          continue
        }
        try {
          const workspace = await ctx.workspaceRegistry.create(
            workspacePath,
            workspaceTitleFor(workspacePath, agent, workspaces, projects),
          )
          await workspace.attachSession(sessionId)
          attached.add(agent.id)
          note(`attached agent ${agent.id} session ${sessionId} workspace ${workspacePath}`)
        } catch (error: unknown) {
          if (!warned.has(agent.id)) {
            warned.add(agent.id)
            note(`attach failed agent ${agent.id} session ${sessionId} workspace ${workspacePath}: ${String(error)}`)
            ctx.logger.warn(
              `paseo-session-workspaces: cannot attach Paseo agent ${agent.id} (${sessionId}): ${String(error)}`,
            )
          }
        }
      }
    } finally {
      scanning = false
    }
  }

  void scan().catch((error: unknown) => ctx.logger.warn(`paseo-session-workspaces: scan failed: ${String(error)}`))
  const stop = ctx.interval(() => {
    void scan().catch((error: unknown) => ctx.logger.warn(`paseo-session-workspaces: scan failed: ${String(error)}`))
  }, scanIntervalMs)
  ctx.effect(() => stop())
}
