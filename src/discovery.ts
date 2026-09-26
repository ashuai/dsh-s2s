/**
 * Session discovery for the s2s seam.
 *
 * Title resolution is layered, cheapest first, and every layer is
 * capability-probed so the plugin keeps working on hosts back to
 * `0.1.0-rc.6`:
 *
 * - **L0** {@link TitleCache} — durable local cache (memory + one small JSON
 *   file), consulted synchronously. The only cross-version accelerant; works
 *   on every host.
 * - **L1** `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])` —
 *   the host's zero-I/O listing read (0.1.7+). A rename is visible at the next
 *   durable checkpoint.
 * - **L3** `sessionQuery.readTitle(id)` — a per-session observation that loads
 *   and folds that session's whole log. This is what made an enumeration cost
 *   ~94 ms per session; kept as the fallback for hosts without the projection
 *   cache (0.1.5 and below).
 * - **L4** on-disk scan of `${DSH_HOME || ~/.dsh}/sessions` with multi-frame
 *   zstd decoding; used when `sessionQuery` is unavailable.
 *
 * Enumeration still comes from `sessionQuery.listSessions()` (or the directory
 * scan): the projection cache answers titles, not the corpus.
 *
 * Freshness: L1 answers from the host's stored projection rows, which track
 * the session's durable checkpoints rather than its every keystroke, and L0
 * holds an answer for up to {@link TITLE_TTL_MS}. A rename therefore becomes
 * visible at the next checkpoint, not mid-turn — the deliberate trade for
 * removing a per-session log read from every enumeration.
 * @module dsh-s2s/discovery
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TitleCache } from './title-cache.ts'

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

/**
 * The host's durable projection cache (0.1.7+), reached structurally so this
 * plugin needs no dependency on the package.
 *
 * Both faces are used, mirroring what the host's own session list does
 * (`dsh-api-session-controller`: `cachedSnapshot(header) ??
 * cachedPredecessorTitle(header)`):
 *
 * - `cachedSnapshot` — the documented zero-I/O listing read of the *current*
 *   checkpoint's rows;
 * - `cachedPredecessorTitle` — a title-only block from a *predecessor*
 *   checkpoint, for the sessions whose current checkpoint carries no title row.
 *
 * Using only the first face was a real defect: every session it could not
 * answer fell through to a per-session `readTitle`, which loads and folds that
 * session's whole log (~39 ms each). Measured against a 238-session corpus that
 * was ~119 fallbacks and a 4.7 s enumeration.
 */
interface SessionProjectionCacheLike {
  cachedSnapshot(meta: unknown, keys?: readonly string[]): ProjectionView | undefined
  cachedPredecessorTitle?(meta: unknown): ProjectionView | undefined
}

/** The shared shape of both projection-cache faces. */
interface ProjectionView {
  readonly values?: { readonly title?: unknown }
}

/** Discovery service config. */
export interface S2sDiscoveryConfig {
  /** Override the `${DSH_HOME}/sessions` scan root (tests, exotic layouts). */
  readonly sessionsRoot?: string
  /** Override the title-cache file path (tests). */
  readonly cachePath?: string
  /** Injectable clock for cache-age tests. */
  readonly now?: () => number
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
  private projectionCache?: SessionProjectionCacheLike
  private readonly sessionsRoot: string | undefined
  private readonly cache: TitleCache
  private readonly now: () => number
  /** In-flight full scan shared by concurrent callers; cleared as soon as it settles. */
  private inflight: Promise<S2sSessionInfo[]> | undefined
  static inject = ['agents']

  constructor(ctx: Context, config?: S2sDiscoveryConfig) {
    super(ctx, 's2sDiscovery')
    this.sessionsRoot = config?.sessionsRoot
    this.cache = new TitleCache(config?.cachePath, (error) => {
      // A denied cache write must be reported once: silently swallowing it turns
      // the whole L0 layer into a no-op and every later call re-reads the corpus.
      ctx.logger?.warn(`s2s discovery: title cache is not writable, falling back to per-call reads: ${String(error)}`)
    })
    this.now = config?.now ?? Date.now
    // Optional dependencies: bind only when the host provides them.
    ctx.inject(['sessionQuery'], (sctx) => {
      this.queryService = (sctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery
    })
    ctx.inject(['sessionProjectionCache'], (sctx) => {
      this.projectionCache = (sctx as unknown as { sessionProjectionCache: SessionProjectionCacheLike }).sessionProjectionCache
    })
  }

  /** The durable title cache; exposed for tooling and tests. */
  titleCache(): TitleCache {
    return this.cache
  }

  /** E3: drop cached titles so the next resolve re-reads them. */
  forgetCachedTitle(sessionId: string): void {
    this.cache.forget(sessionId)
  }

  /**
   * L1: read one title from the host's projection cache (0.1.7+).
   *
   * `cachedSnapshot` is the documented zero-I/O listing read — it views stored
   * projection rows and never opens a log. It is version- and lifecycle-matched,
   * so it returns `undefined` whenever no usable row exists (including after a
   * session format change, the case that keeps L3 alive).
   *
   * @param meta - the listing header that witnesses this session's lifecycle.
   * @returns `{ title }` when a row answered (a missing title is a real answer),
   *   or `undefined` when this layer cannot answer at all.
   */
  private readTitleFromL1(meta: unknown): { title: string | undefined } | undefined {
    const projection = this.projectionCache
    if (projection === undefined || typeof projection.cachedSnapshot !== 'function') return undefined
    try {
      // Current checkpoint first, then the predecessor title — the same two
      // faces, in the same order, that the host's own session list consults.
      // Without the second, a session whose current checkpoint has no title row
      // falls all the way through to a full per-session log read.
      const snapshot = projection.cachedSnapshot(meta, ['title'])
        ?? (typeof projection.cachedPredecessorTitle === 'function' ? projection.cachedPredecessorTitle(meta) : undefined)
      if (snapshot === undefined) return undefined
      const value = snapshot.values?.title
      return { title: typeof value === 'string' && value.length > 0 ? value : undefined }
    } catch {
      return undefined // a broken cache is a miss, never a failure
    }
  }

  /**
   * Resolve one session's title as cheaply as the host allows.
   *
   * Order: L0 cache → L1 projection cache → L3 single read → L4 on-disk scan.
   * A result is retained in L0 when it came from a real read; a title-less
   * result only is when `sessionDir` is known — otherwise every later call
   * would re-read a genuinely untitled session.
   *
   * @param sessionId - exact session id.
   * @param meta - the listing header, required for L1's lifecycle match.
   * @param sessionDir - on-disk directory for the L4 fallback.
   * @param workspaceDir - listing workspace directory, retained in L0.
   * @returns the title, or undefined when no layer produced one.
   */
  private async readTitleLayered(
    sessionId: string,
    meta?: unknown,
    sessionDir?: string,
    workspaceDir?: string,
  ): Promise<string | undefined> {
    const cached = this.cache.get(sessionId, this.now()) // E1/E4
    if (cached !== undefined) return cached.title

    let title: string | undefined
    let read = false

    // L1: zero-I/O listing read.
    const fromL1 = this.readTitleFromL1(meta)
    if (fromL1 !== undefined) {
      title = fromL1.title
      read = true
    }

    // L3: single-session observation.
    const query = this.queryService
    if (!read && query !== undefined && typeof query.readTitle === 'function') {
      try {
        title = (await query.readTitle(SessionId(sessionId)))?.title
        read = true
      } catch { /* fall through to the on-disk scan */ }
    }

    // L4: read the log ourselves.
    if (!read && sessionDir !== undefined) {
      title = await this.readTitleFromFs(sessionDir)
      read = true
    }

    if (read && (title !== undefined || sessionDir !== undefined)) {
      this.cache.set(sessionId, title, this.now(), workspaceDir)
    }
    return title
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
      // L0 fast path: a cached hit that knows its workspace answers with no
      // enumeration and no read at all.
      const cached = this.cache.get(sessionId, this.now())
      if (cached !== undefined && cached.workspaceDir !== undefined) {
        return toOk({
          sessionId,
          ...(cached.title === undefined ? {} : { title: cached.title }),
          state: this.stateOf(sessionId),
          workspaceDir: cached.workspaceDir,
        })
      }
      // Fast path: an exact id needs only that session's title, not the corpus.
      const exact = await this.collectById(sessionId)
      if (exact !== undefined) return toOk(exact)
    }

    // L0 fast path for name addressing: exactly one cached session owns this
    // name, so answer without enumerating. Two or more cached owners means the
    // name may be ambiguous — fall through to the corpus for a real verdict.
    const needle = name?.trim().toLowerCase()
    if (needle !== undefined && needle.length > 0) {
      const owners = this.cache.findByName(needle)
      if (owners.length === 1) {
        const cached = this.cache.get(owners[0]!, this.now())
        if (cached?.workspaceDir !== undefined) {
          return toOk({
            sessionId: owners[0]!,
            ...(cached.title === undefined ? {} : { title: cached.title }),
            state: this.stateOf(owners[0]!),
            workspaceDir: cached.workspaceDir,
          })
        }
      } else if (owners.length > 1) {
        // E2: record the collision so it is not answered from cache again.
        for (const owner of owners) this.cache.markAmbiguous(owner, this.now())
      }
    }

    const infos = await this.collect()
    if (needle === undefined || needle.length === 0) return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    const matches = infos.filter(info => info.title?.trim().toLowerCase() === needle)
    if (matches.length === 0) return { kind: 'not-found', name: name ?? '', candidates: infos.map(toCandidate) }
    if (matches.length > 1) {
      // E2: remember the ambiguity so the cache never resolves this name alone.
      for (const match of matches) this.cache.markAmbiguous(match.sessionId, this.now())
      return { kind: 'ambiguous', name: name ?? '', candidates: matches.map(toCandidate) }
    }
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
        // L1 answers from the host's projection cache; L0 may answer with no
        // enumeration at all on a repeat call (handled by resolve()).
        const title = await this.readTitleLayered(sessionId, record.header, undefined, record.header.cwd)
        return toInfo(record, sessionId, title, this.stateOf(sessionId))
      } catch { /* fall through to the full scan */ }
    }
    const infos = await this.collect()
    return infos.find(entry => entry.sessionId === sessionId)
  }

  /**
   * Enumerate from `sessionQuery`, cheapest source first per record:
   * L0 cache → L1 projection cache → L3 per-session read.
   *
   * Titles are retained in L0 so a later call pays nothing at all, and on
   * 0.1.7+ L1 answers the first call with zero log reads.
   */
  private async collectFromQuery(query: SessionQueryLike): Promise<S2sSessionInfo[]> {
    const records = await query.listSessions()
    const titles = new Map<string, string | undefined>()
    const misses: SessionRecordLike[] = []

    for (const record of records) {
      const sessionId = String(record.header.id)
      const cached = this.cache.get(sessionId, this.now()) // E1/E4
      if (cached !== undefined) {
        titles.set(sessionId, cached.title)
        continue
      }
      const fromL1 = this.readTitleFromL1(record.header)
      if (fromL1 !== undefined) {
        // A title-less row is a real answer, not a miss.
        titles.set(sessionId, fromL1.title)
        this.cache.set(sessionId, fromL1.title, this.now(), record.header.cwd)
        continue
      }
      misses.push(record)
    }

    return mapLimit(records, READ_CONCURRENCY, async (record): Promise<S2sSessionInfo> => {
      const sessionId = String(record.header.id)
      if (titles.has(sessionId)) {
        return toInfo(record, sessionId, titles.get(sessionId), this.stateOf(sessionId))
      }
      // L3: a single-session observation. The only path on hosts without the
      // projection cache (0.1.5 and below), and the fallback on 0.1.7+ when no
      // cached row exists yet for this session.
      const title = await this.readTitleLayered(sessionId, record.header, undefined, record.header.cwd)
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
      // L0 first: on hosts with no sessionQuery this is the whole acceleration.
      const cached = this.cache.get(sessionId, this.now())
      let title = cached?.title
      if (cached === undefined) {
        title = await this.readTitleLayered(sessionId, undefined, join(root, workspaceDir, entry), workspaceDir)
        this.cache.set(sessionId, title, this.now(), workspaceDir)
      }
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
        const title = latestTitleFromZstd(z)
        if (title !== undefined) return title
      }
      const plain = await readFile(join(sessionDir, 'session.jsonl'), 'utf8').catch(() => undefined)
      if (plain !== undefined) return titleFromJsonl(plain)
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

/** Zstandard frame magic, little-endian `28 B5 2F FD`. */
const ZSTD_MAGIC = 0xfd2fb528

interface ZstdFrame {
  readonly start: number
  readonly end: number
}

/**
 * Locate every complete Zstandard frame in a concatenated log without decoding
 * its blocks. Session logs are append-only: each append is its own frame, so a
 * real log holds thousands of frames.
 *
 * A structurally invalid complete frame throws (the caller degrades to "no
 * title"); EOF inside the final frame returns its start as `tornStart` and
 * stops, so a crash-truncated log still yields every frame written before it.
 *
 * @param buf - the complete bytes currently on disk.
 * @returns complete frame ranges, plus the start of an optional incomplete tail.
 */
function scanZstdFrames(buf: Buffer): { frames: ZstdFrame[]; tornStart?: number } {
  const frames: ZstdFrame[] = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Latest `session/title` over a concatenated-zstd log (append-only
 * multi-frame), or undefined when the log is absent, empty, corrupt, or has no
 * title event.
 *
 * Frames are decoded one at a time and only the latest title is retained, so a
 * large log never materializes as one giant string. A single frame failing to
 * decode throws (the caller falls back to "no title"), matching the previous
 * all-or-nothing behavior.
 */
function latestTitleFromZstd(buf: Buffer): string | undefined {
  const { frames } = scanZstdFrames(buf)
  let title: string | undefined
  for (const frame of frames) {
    const text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    const found = titleFromJsonl(text)
    if (found !== undefined) title = found
  }
  return title
}

/** Latest `session/title` title over one frame of JSONL; undefined if none. */
function titleFromJsonl(text: string): string | undefined {
  let title: string | undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try { const event = JSON.parse(line) as { type?: string; data?: { title?: unknown } }; if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.length > 0) title = event.data.title } catch {}
  }
  return title
}
