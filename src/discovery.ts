/**
 * Session discovery for the s2s seam: enumerate the host's complete session
 * corpus via `ctx.sessionQuery.listSessions()` (the same source the GUI list
 * uses — includes live AND persisted/dormant sessions), read titles via
 * `ctx.sessionQuery.readTitle(sessionId)` (works on live or persisted), and
 * derive live state from the agent registry (`ctx.agents`).
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

interface SessionRecordLike {
  readonly header: { readonly id: unknown; readonly cwd?: string }
  readonly live: boolean
}

interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readTitle(sessionId: unknown): Promise<{ readonly title?: string } | undefined>
}

export class S2sDiscoveryService extends Service {
  static inject = ['agents', 'sessionQuery']

  constructor(ctx: Context) {
    super(ctx, 's2sDiscovery')
  }

  liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  async list(query?: string): Promise<S2sSessionInfo[]> {
    const needle = query?.toLowerCase()
    const infos = await this.collect()
    const filtered = needle === undefined
      ? infos
      : infos.filter(info => info.title?.toLowerCase().includes(needle) || info.sessionId.toLowerCase().includes(needle) || info.workspaceDir.toLowerCase().includes(needle))
    return filtered
  }

  async resolve(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult> {
    const infos = await this.collect()
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

  /** Enumerate the complete corpus (live + persisted) with titles + states. */
  private async collect(): Promise<S2sSessionInfo[]> {
    const query = (this.ctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery
    const records = await query.listSessions()
    const infos: S2sSessionInfo[] = []
    for (const record of records) {
      const sessionId = String(record.header.id)
      const agent = this.ctx.agents.get(SessionId(sessionId))
      const state = agent !== undefined ? (agent.status === 'idle' ? 'live-idle' : 'live-busy') : 'dormant'
      let title: string | undefined
      try { title = (await query.readTitle(SessionId(sessionId)))?.title } catch { title = undefined }
      infos.push({ sessionId, ...(title === undefined ? {} : { title }), workspaceDir: record.header.cwd ?? '?', state })
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

