/**
 * Session discovery for the s2s seam: enumerate the sessions the host knows
 * about — the same live store the GUI lists (`ctx.sessions.list()`) — and read
 * titles via the session-title service (`ctx.sessionTitle.get(session)`), so
 * `s2s_sessions` matches what the user sees. Live state comes from the agent
 * registry (`ctx.agents.get(id)`); a known-but-not-live session is dormant.
 * @module dsh-s2s/discovery
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One discovered session with its lifecycle state and current title. */
export interface S2sSessionInfo {
  readonly sessionId: string
  readonly title?: string
  readonly workspaceDir: string
  readonly state: 'live-idle' | 'live-busy' | 'dormant'
  readonly lastActivity?: number
}

export type S2sCandidate = Pick<S2sSessionInfo, 'sessionId' | 'title' | 'workspaceDir' | 'state'>

export type S2sResolveResult =
  | { readonly kind: 'ok'; readonly sessionId: string; readonly title?: string; readonly state: S2sSessionInfo['state']; readonly workspaceDir: string }
  | { readonly kind: 'not-found'; readonly name: string; readonly candidates: S2sCandidate[] }
  | { readonly kind: 'ambiguous'; readonly name: string; readonly candidates: S2sCandidate[] }

interface SessionLike {
  readonly id: unknown
  readonly header?: { readonly cwd?: string }
}

interface TitleLike {
  get(session: SessionLike): { readonly title?: string } | undefined
}

/**
 * The discovery service. Mounted alongside the mesh; reads the live session
 * store through the injected session service, titles through the session-title
 * service (optional), and liveness through the agent registry.
 */
export class S2sDiscoveryService extends Service {
  static inject = ['agents', 'sessions']

  constructor(ctx: Context) {
    super(ctx, 's2sDiscovery')
  }

  /** The live agent for one session id, when registered. */
  liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  async list(query?: string): Promise<S2sSessionInfo[]> {
    const needle = query?.toLowerCase()
    const infos = this.collect()
    const filtered = needle === undefined
      ? infos
      : infos.filter(info => info.title?.toLowerCase().includes(needle) || info.sessionId.toLowerCase().includes(needle) || info.workspaceDir.toLowerCase().includes(needle))
    return filtered.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
  }

  async resolve(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult> {
    const infos = this.collect()
    if (sessionId !== undefined && sessionId.length > 0) {
      const exact = infos.find(info => info.sessionId === sessionId)
      if (exact !== undefined) return toOk(exact)
    }
    const needle = name?.trim().toLowerCase()
    if (needle === undefined || needle.length === 0) return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    const matches = infos.filter(info => info.title?.trim().toLowerCase() === needle)
    if (matches.length === 0) return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    if (matches.length > 1) return { kind: 'ambiguous', name: name ?? '', candidates: matches.map(toCandidate) }
    return toOk(matches[0]!)
  }

  /** Enumerate the live session store (same source as the GUI list). */
  private collect(): S2sSessionInfo[] {
    const sessions = this.ctx.sessions.list() as unknown as SessionLike[]
    const titleService = (this.ctx as unknown as { get(key: string): TitleLike | undefined }).get('sessionTitle')
    const infos: S2sSessionInfo[] = []
    for (const session of sessions) {
      const sessionId = String(session.id)
      const agent = this.ctx.agents.get(SessionId(sessionId))
      const state = agent === undefined ? 'dormant' : agent.status === 'idle' ? 'live-idle' : 'live-busy'
      const title = titleService?.get(session)?.title
      infos.push({ sessionId, ...(title === undefined ? {} : { title }), workspaceDir: session.header?.cwd ?? '?', state })
    }
    return infos
  }
}

function toCandidate(info: S2sSessionInfo): S2sCandidate {
  return { sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), workspaceDir: info.workspaceDir, state: info.state }
}

function toOk(info: S2sSessionInfo): S2sResolveResult {
  return { kind: 'ok', sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), state: info.state, workspaceDir: info.workspaceDir }
}

