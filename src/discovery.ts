/**
 * Session discovery for the s2s seam. Primary source:
 * `ctx.sessionQuery.listSessions()` — the host's complete logical corpus (live
 * and persisted/dormant), which is what the GUI session list uses — plus
 * `ctx.sessionQuery.readTitle(sessionId)` for titles (live or persisted) and
 * `ctx.agents` for live state. Fallback (when the sessionQuery service is
 * unavailable): scan ${DSH_HOME || ~/.dsh}/sessions for on-disk session dirs.
 * @module dsh-s2s/discovery
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

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

interface SessionRecordLike { readonly header: { readonly id: unknown; readonly cwd?: string }; readonly live: boolean }
interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readTitle(sessionId: unknown): Promise<{ readonly title?: string } | undefined>
}

export class S2sDiscoveryService extends Service {
  static inject = ['agents']

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

  /** Enumerate the complete corpus: sessionQuery primary, DSH_HOME scan fallback. */
  private async collect(): Promise<S2sSessionInfo[]> {
    const query = (this.ctx as unknown as { sessionQuery?: SessionQueryLike }).sessionQuery
    if (query !== undefined && typeof query.listSessions === 'function') {
      try { return await this.collectFromQuery(query) } catch { /* fall through to FS scan */ }
    }
    return this.collectFromFs()
  }

  private async collectFromQuery(query: SessionQueryLike): Promise<S2sSessionInfo[]> {
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

  private async collectFromFs(): Promise<S2sSessionInfo[]> {
    const home = process.env.DSH_HOME || process.env.DSH_DATA_DIR
    const root = home ? join(home, 'sessions') : join(homedir(), '.dsh', 'sessions')
    const infos: S2sSessionInfo[] = []
    let level: string[] = []
    try { level = await readdir(root) } catch { level = [] }
    for (const workspaceDir of level) {
      const dir = join(root, workspaceDir)
      let entries: string[] = []
      try { entries = await readdir(dir) } catch { continue }
      for (const entry of entries) {
        if (!entry.startsWith('session-')) continue
        const sessionId = entry.slice('session-'.length)
        if (sessionId.length === 0) continue
        const agent = this.ctx.agents.get(SessionId(sessionId))
        const state = agent !== undefined ? (agent.status === 'idle' ? 'live-idle' : 'live-busy') : 'dormant'
        const title = await this.readTitleFromFs(join(dir, entry))
        infos.push({ sessionId, ...(title === undefined ? {} : { title }), workspaceDir, state })
      }
    }
    return infos
  }

  private async readTitleFromFs(sessionDir: string): Promise<string | undefined> {
    try {
      const z = await readFile(join(sessionDir, 'session.jsonl.zstd')).catch(() => undefined)
      if (z !== undefined) {
        const text = await decompressZstdAll(z)
        const title = latestTitleFromJsonl(text)
        if (title !== undefined) return title
      }
      const plain = await readFile(join(sessionDir, 'session.jsonl'), 'utf8').catch(() => undefined)
      if (plain !== undefined) return latestTitleFromJsonl(plain)
    } catch {}
    return undefined
  }
}

function toCandidate(info: S2sSessionInfo): S2sCandidate {
  return { sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), workspaceDir: info.workspaceDir, state: info.state }
}

function toOk(info: S2sSessionInfo): S2sResolveResult {
  return { kind: 'ok', sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), state: info.state, workspaceDir: info.workspaceDir }
}

/** Fully decompress a concatenated-zstd log (append-only multi-frame). */
function decompressZstdAll(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const dec = zlib.createZstdDecompress()
    dec.on('data', (c: Buffer) => chunks.push(c))
    dec.on('error', reject)
    dec.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    dec.end(buf)
  })
}

/** Latest `session/title` title over one JSONL log text; undefined if none. */
function latestTitleFromJsonl(text: string): string | undefined {
  let title: string | undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try { const event = JSON.parse(line) as { type?: string; data?: { title?: unknown } }; if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.length > 0) title = event.data.title } catch {}
  }
  return title
}

