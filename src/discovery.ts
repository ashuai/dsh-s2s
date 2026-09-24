/**
 * Session discovery for the s2s seam. Primary source:
 * `ctx.sessionQuery.listSessions()` — the host's complete logical corpus (live
 * and persisted/dormant), which is what the GUI session list uses — plus
 * `ctx.sessionQuery.readTitle(sessionId)` for titles (live or persisted) and
 * `ctx.agents` for live state. Fallback (when the sessionQuery service is
 * unavailable): scan ${DSH_HOME || ~/.dsh}/sessions for on-disk session dirs.
 *
 * Perf: per-session title reads are the expensive part, so enumeration runs
 * them with bounded concurrency (never a serial await loop), an exact
 * session_id resolve reads only that one title, and concurrent collects
 * coalesce onto a single in-flight scan. Titles are deliberately not cached —
 * address resolution always reads the freshest title (a rename is visible at
 * once), matching the documented addressing semantics.
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

/** Max concurrent title reads / log scans; bounds open FDs on a large corpus. */
const READ_CONCURRENCY = 8

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const workers = Math.min(Math.max(limit, 1), items.length)
  let next = 0
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  }))
  return results
}

export class S2sDiscoveryService extends Service {
  private queryService?: SessionQueryLike
  private readonly sessionsRoot: string | undefined
  /** In-flight full scan shared by concurrent callers; cleared as soon as it settles. */
  private inflight: Promise<S2sSessionInfo[]> | undefined
  static inject = ['agents']

  constructor(ctx: Context, config?: { sessionsRoot?: string }) {
    super(ctx, 's2sDiscovery')
    this.sessionsRoot = config?.sessionsRoot
    // Optional dependency: bind only when the sessionQuery service exists.
    ctx.inject(['sessionQuery'], (sctx) => {
      this.queryService = (sctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery
    })
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
    if (sessionId !== undefined && sessionId.length > 0) {
      // Fast path: an exact id needs only that session's title, not the corpus.
      const exact = await this.collectById(sessionId)
      if (exact !== undefined) return toOk(exact)
    }
    const infos = await this.collect()
    const needle = name?.trim().toLowerCase()
    if (needle === undefined || needle.length === 0) return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    const matches = infos.filter(info => info.title?.trim().toLowerCase() === needle)
    if (matches.length === 0) return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    if (matches.length > 1) return { kind: 'ambiguous', name: name ?? '', candidates: matches.map(toCandidate) }
    return toOk(matches[0]!)
  }

  /**
   * Coalesce concurrent full scans: callers arriving while a scan is in flight
   * share it instead of re-enumerating. Cleared as soon as it settles, so a
   * later call always re-reads (titles stay fresh).
   */
  private collect(): Promise<S2sSessionInfo[]> {
    const running = this.inflight
    if (running !== undefined) return running
    const run = this.collectUncached()
    this.inflight = run
    const clear = (): void => { if (this.inflight === run) this.inflight = undefined }
    run.then(clear, clear)
    return run
  }

  /** Enumerate the complete corpus: sessionQuery primary, DSH_HOME scan fallback. */
  private async collectUncached(): Promise<S2sSessionInfo[]> {
    const query = this.queryService
    if (query !== undefined && typeof query.listSessions === 'function') {
      try { return await this.collectFromQuery(query) } catch { /* fall through to FS scan */ }
    }
    return this.collectFromFs()
  }

  /** One exact session id without reading every other session's title. */
  private async collectById(sessionId: string): Promise<S2sSessionInfo | undefined> {
    const query = this.queryService
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        const record = records.find(entry => String(entry.header.id) === sessionId)
        if (record === undefined) return undefined
        let title: string | undefined
        try { title = (await query.readTitle(SessionId(sessionId)))?.title } catch { title = undefined }
        return toInfo(record, sessionId, title, this.stateOf(sessionId))
      } catch { /* fall through to the full scan */ }
    }
    const infos = await this.collect()
    return infos.find(entry => entry.sessionId === sessionId)
  }

  private async collectFromQuery(query: SessionQueryLike): Promise<S2sSessionInfo[]> {
    const records = await query.listSessions()
    return mapLimit(records, READ_CONCURRENCY, async (record): Promise<S2sSessionInfo> => {
      const sessionId = String(record.header.id)
      let title: string | undefined
      try { title = (await query.readTitle(SessionId(sessionId)))?.title } catch { title = undefined }
      return toInfo(record, sessionId, title, this.stateOf(sessionId))
    })
  }

  private async collectFromFs(): Promise<S2sSessionInfo[]> {
    const home = process.env.DSH_HOME || process.env.DSH_DATA_DIR
    const root = this.sessionsRoot ?? (home ? join(home, 'sessions') : join(homedir(), '.dsh', 'sessions'))
    let level: string[] = []
    try { level = await readdir(root) } catch { level = [] }
    const targets: { workspaceDir: string; entry: string }[] = []
    for (const workspaceDir of level) {
      const dir = join(root, workspaceDir)
      let entries: string[] = []
      try { entries = await readdir(dir) } catch { continue }
      for (const entry of entries) {
        if (entry.startsWith('session-') && entry.length > 'session-'.length) targets.push({ workspaceDir, entry })
      }
    }
    return mapLimit(targets, READ_CONCURRENCY, async ({ workspaceDir, entry }): Promise<S2sSessionInfo> => {
      const sessionId = entry.slice('session-'.length)
      const title = await this.readTitleFromFs(join(root, workspaceDir, entry))
      return { sessionId, ...(title === undefined ? {} : { title }), workspaceDir, state: this.stateOf(sessionId) }
    })
  }

  private stateOf(sessionId: string): S2sSessionInfo['state'] {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    return agent !== undefined ? (agent.status === 'idle' ? 'live-idle' : 'live-busy') : 'dormant'
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

/** Build one row from a query record + its resolved title and live state. */
function toInfo(record: SessionRecordLike, sessionId: string, title: string | undefined, state: S2sSessionInfo['state']): S2sSessionInfo {
  return { sessionId, ...(title === undefined ? {} : { title }), workspaceDir: record.header.cwd ?? '?', state }
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
