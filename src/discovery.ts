/**
 * Session discovery for the s2s seam: merge the live agent registry with the
 * on-disk session store so the model can see dormant (done) sessions next to
 * live ones. Live state wins over the filesystem record; a session with no
 * live agent and a store directory is dormant.
 * @module dsh-s2s/discovery
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One discovered session with its lifecycle state. */
export interface S2sSessionInfo {
  readonly sessionId: string
  /** The encoded workspace directory name from the store path (not decoded). */
  readonly workspaceDir: string
  readonly state: 'live-idle' | 'live-busy' | 'dormant'
  /** Store directory mtime (epoch ms), when the store knows this session. */
  readonly lastActivity?: number
}

/** Default on-disk session store root. */
export const DEFAULT_SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

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
   * the session id or workspace directory name.
   */
  async list(query?: string): Promise<S2sSessionInfo[]> {
    const needle = query?.toLowerCase()
    const sessions = new Map<string, { workspaceDir: string; lastActivity?: number }>()
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
        try {
          const lastActivity = (await stat(join(dir, entry))).mtimeMs
          sessions.set(sessionId, { workspaceDir, lastActivity })
        } catch {
          sessions.set(sessionId, { workspaceDir })
        }
      }
    }
    const infos: S2sSessionInfo[] = []
    for (const [sessionId, record] of sessions) {
      const agent = this.ctx.agents.get(SessionId(sessionId))
      const state = agent === undefined
        ? 'dormant'
        : agent.status === 'idle' ? 'live-idle' : 'live-busy'
      infos.push({ sessionId, workspaceDir: record.workspaceDir, state, ...(record.lastActivity === undefined ? {} : { lastActivity: record.lastActivity }) })
    }
    const filtered = needle === undefined
      ? infos
      : infos.filter(info => info.sessionId.toLowerCase().includes(needle) || info.workspaceDir.toLowerCase().includes(needle))
    return filtered.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
  }

  /** The live agent for one session id, when registered. */
  liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }
}
