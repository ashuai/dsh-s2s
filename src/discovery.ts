/**
 * Session discovery for the s2s seam: merge the live agent registry with the
 * on-disk session store so the model can see dormant (done) sessions next to
 * live ones. Live state wins over the filesystem record; a session with no
 * live agent and a store directory is dormant.
 *
 * Titles are read **fresh from each session's log** (the latest `session/title`
 * event) on every call — never cached, because the user can rename a session
 * at any time. Name-based resolution therefore always reflects the current
 * name, and never mistakes a stale title for a live one.
 * @module dsh-s2s/discovery
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One discovered session with its lifecycle state and current title. */
export interface S2sSessionInfo {
  readonly sessionId: string
  /** The session's current user-facing title (latest `session/title` event). */
  readonly title?: string
  /** The encoded workspace directory name from the store path (not decoded). */
  readonly workspaceDir: string
  readonly state: 'live-idle' | 'live-busy' | 'dormant'
  /** Store directory mtime (epoch ms), when the store knows this session. */
  readonly lastActivity?: number
}

/** A candidate surfaced when resolution is ambiguous or empty. */
export type S2sCandidate = Pick<S2sSessionInfo, 'sessionId' | 'title' | 'workspaceDir' | 'state'>

/** Name/session-id resolution outcome. */
export type S2sResolveResult =
  | { readonly kind: 'ok'; readonly sessionId: string; readonly title?: string; readonly state: S2sSessionInfo['state']; readonly workspaceDir: string }
  | { readonly kind: 'not-found'; readonly name: string; readonly candidates: S2sCandidate[] }
  | { readonly kind: 'ambiguous'; readonly name: string; readonly candidates: S2sCandidate[] }

/** Default on-disk session store root: DSH_HOME/DSH_DATA env, else ~/.dsh/sessions. */
export const DEFAULT_SESSIONS_ROOT = (() => {
  const env = process.env.DSH_HOME || process.env.DSH_DATA_DIR
  return env ? join(env, 'sessions') : join(homedir(), '.dsh', 'sessions')
})()

/**
 * The discovery service. Mounted alongside the mesh; reads the live registry
 * through the injected agent service and scans the store lazily per call.
 */
export class S2sDiscoveryService extends Service {
  static inject = ['agents']

  private readonly sessionsRoot: string

  constructor(ctx: Context, config?: { sessionsRoot?: string }) {
    super(ctx, 's2sDiscovery')
    this.sessionsRoot = config?.sessionsRoot ?? DEFAULT_SESSIONS_ROOT
  }

  /**
   * List sessions, optionally filtered by a case-insensitive substring over
   * the title, session id, or workspace directory name. Titles are re-read
   * from each session's log on every call.
   */
  async list(query?: string): Promise<S2sSessionInfo[]> {
    const needle = query?.toLowerCase()
    const sessions = await this.collect()
    const infos: S2sSessionInfo[] = []
    for (const [sessionId, record] of sessions) {
      const agent = this.ctx.agents.get(SessionId(sessionId))
      const state = agent === undefined ? 'dormant' : agent.status === 'idle' ? 'live-idle' : 'live-busy'
      const title = await this.readTitle(record.dir)
      infos.push({
        sessionId,
        ...(title === undefined ? {} : { title }),
        workspaceDir: record.workspaceDir,
        state,
        ...(record.lastActivity === undefined ? {} : { lastActivity: record.lastActivity }),
      })
    }
    const filtered = needle === undefined
      ? infos
      : infos.filter(info =>
        info.title?.toLowerCase().includes(needle)
        || info.sessionId.toLowerCase().includes(needle)
        || info.workspaceDir.toLowerCase().includes(needle))
    return filtered.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
  }

  /**
   * Resolve a session by **name (title)** — the primary, user-facing path —
   * or by an explicit session id. Titles are read fresh (renames are always
   * reflected); a name that matches more than one session is reported as
   * ambiguous rather than guessed; an empty match lists candidates.
   */
  async resolve(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult> {
    const sessions = await this.collect()
    const build = async (id: string, record: { workspaceDir: string; dir: string; lastActivity?: number } | undefined): Promise<S2sResolveResult | undefined> => {
      const agent = this.ctx.agents.get(SessionId(id))
      const state = agent === undefined ? 'dormant' : agent.status === 'idle' ? 'live-idle' : 'live-busy'
      const title = record === undefined ? undefined : await this.readTitle(record.dir)
      return {
        kind: 'ok',
        sessionId: id,
        ...(title === undefined ? {} : { title }),
        state,
        workspaceDir: record?.workspaceDir ?? '?',
      }
    }

    if (sessionId !== undefined && sessionId.length > 0) {
      const record = sessions.get(sessionId)
      const built = await build(sessionId, record)
      if (built !== undefined) return built
    }

    // Build all infos once (title + state per session) so candidates can
    // be surfaced for both empty and ambiguous matches.
    const infos: S2sSessionInfo[] = []
    for (const [id, record] of sessions) {
      const agent = this.ctx.agents.get(SessionId(id))
      const state = agent === undefined ? 'dormant' : this.stateOf(agent)
      const title = await this.readTitle(record.dir)
      infos.push({ sessionId: id, ...(title === undefined ? {} : { title }), workspaceDir: record.workspaceDir, state })
    }
    const needle = name?.trim().toLowerCase()
    if (needle === undefined || needle.length === 0) {
      return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    }
    const matches = infos.filter(info => info.title?.trim().toLowerCase() === needle)
    if (matches.length === 0) {
      // Not found: suggest every named session so the caller can pick.
      return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    }
    if (matches.length > 1) {
      return { kind: 'ambiguous', name: name ?? '', candidates: matches.map(toCandidate) }
    }
    const matched = matches[0]!
    return { kind: 'ok', sessionId: matched.sessionId, ...(matched.title === undefined ? {} : { title: matched.title }), state: matched.state, workspaceDir: matched.workspaceDir }
  }

  /** The live agent for one session id, when registered. */
  liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  /** Scan the store once; each entry keeps its directory for title reads. */
  private async collect(): Promise<Map<string, { workspaceDir: string; dir: string; lastActivity?: number }>> {
    const sessions = new Map<string, { workspaceDir: string; dir: string; lastActivity?: number }>()
    let level: string[] = []
    try {
      level = await readdir(this.sessionsRoot)
    } catch {
      level = []
    }
    for (const workspaceDir of level) {
      const dir = join(this.sessionsRoot, workspaceDir)
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.startsWith('session-')) continue
        const sessionId = entry.slice('session-'.length)
        if (sessionId.length === 0) continue
        const sessionDir = join(dir, entry)
        try {
          const lastActivity = (await stat(sessionDir)).mtimeMs
          sessions.set(sessionId, { workspaceDir, dir: sessionDir, lastActivity })
        } catch {
          sessions.set(sessionId, { workspaceDir, dir: sessionDir })
        }
      }
    }
    return sessions
  }

  /** Latest `session/title` title from a session's log (zstd or plain). */
  private async readTitle(sessionDir: string): Promise<string | undefined> {
    try {
      const z = await readFile(join(sessionDir, 'session.jsonl.zstd')).catch(() => undefined)
      if (z !== undefined) {
        const text = (typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function')
          ? Buffer.from((zlib as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(z)).toString('utf8')
          : ''
        const title = latestTitleFromJsonl(text)
        if (title !== undefined) return title
      }
      const plain = await readFile(join(sessionDir, 'session.jsonl'), 'utf8').catch(() => undefined)
      if (plain !== undefined) return latestTitleFromJsonl(plain)
    } catch {
      // Unreadable log simply means no title; never block discovery.
    }
    return undefined
  }

  private stateOf(agent: Agent): S2sSessionInfo['state'] {
    return agent.status === 'idle' ? 'live-idle' : 'live-busy'
  }
}

/** Project one info into a compact candidate (sessionId/title/ws/state). */
function toCandidate(info: S2sSessionInfo): S2sCandidate {
  return { sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), workspaceDir: info.workspaceDir, state: info.state }
}

/** Latest `session/title` title over one JSONL log text; undefined if none. */
function latestTitleFromJsonl(text: string): string | undefined {
  let title: string | undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const event = JSON.parse(line) as { type?: string; data?: { title?: unknown } }
      if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.length > 0) {
        title = event.data.title
      }
    } catch {
      // Skip non-JSON or corrupt lines.
    }
  }
  return title
}
