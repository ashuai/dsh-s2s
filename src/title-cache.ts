/**
 * Durable session-title cache for the s2s discovery seam.
 *
 * Why this exists: resolving a name used to decode every session log on every
 * call — 855k zstd frames in one measured corpus, ~9 s of pure decode per
 * enumeration, paid again on the next call. The host's projection cache (see
 * L1 in `discovery.ts`) removes that on 0.1.7+, but plugins must also serve
 * hosts back to `0.1.0-rc.6`, where no such service exists. This cache is the
 * only cross-version acceleration layer.
 *
 * Invalidation is deliberately lazy and event-driven — a changed log file does
 * NOT invalidate an entry. An entry is re-read only when:
 *
 * - **E1 miss** — nothing cached for this name/id;
 * - **E2 wrong** — a cached mapping is contradicted (recorded as ambiguous);
 * - **E3 forced** — the caller asks for a re-read (`forget` / `force`);
 * - **E4 age** — the entry was last touched more than {@link TITLE_TTL_MS} ago.
 *
 * Accepted cost: a renamed session keeps answering to its previous name until
 * one of E1–E4 fires. Resolution by session id is never affected (ids are
 * immutable), and a stale entry never points at an unrelated session.
 *
 * @module dsh-s2s/title-cache
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One cached observation of a session's title. */
export interface TitleCacheEntry {
  /** Latest observed title; absent when the log had none at read time. */
  readonly title?: string
  /** Workspace directory from the listing that produced this entry. */
  readonly workspaceDir?: string
  /** Epoch ms of the last cache hit or write; drives E4. */
  lastAccess: number
  /** Epoch ms the title was actually read from a source (freshness age). */
  readonly builtAt: number
  /** Recorded when one name maps to more than one session (E2 marker). */
  ambiguous?: boolean
}

/** E4 budget: entries older than this are re-read. */
export const TITLE_TTL_MS = 24 * 60 * 60 * 1000

/** On-disk envelope; `version` must bump when {@link TitleCacheEntry} changes. */
interface TitleCacheFile {
  readonly version: 1
  readonly sessions: Record<string, TitleCacheEntry>
}

/**
 * Resolve the cache file path.
 *
 * Persistence is enabled only when the deployment actually declares a DSH home
 * (`DSH_HOME` / `DSH_DATA_DIR`). A harness booted without one — every unit test,
 * and any ad-hoc embed — then gets a purely in-process cache instead of a file
 * in the user's real `~/.dsh`. That keeps the plugin from writing deployment
 * state it was never told about, and keeps tests hermetic by default.
 *
 * @returns the cache path, or undefined for a memory-only cache.
 */
function defaultCachePath(): string | undefined {
  const home = process.env.DSH_HOME || process.env.DSH_DATA_DIR
  return home === undefined || home.length === 0 ? undefined : join(home, 's2s', 'title-cache.json')
}

/**
 * The title cache: an in-process map backed by one small JSON file.
 *
 * Reads are synchronous and allocation-light so callers can consult it per
 * session without awaiting. Writes are debounced; {@link TitleCache.flush}
 * forces the pending state to disk (tests and shutdown use it).
 */
export class TitleCache {
  private readonly entries = new Map<string, TitleCacheEntry>()
  private readonly filePath: string | undefined
  private loaded = false
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  /** Debounce window for persistence; short enough to survive a crash. */
  private static readonly FLUSH_DELAY_MS = 250

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultCachePath()
  }

  /** Whether this cache persists to disk at all. */
  get persistent(): boolean {
    return this.filePath !== undefined
  }

  /** Load the persisted map once, tolerating any malformed or absent file. */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (this.filePath === undefined) return
    // Synchronous by design: the first resolve must not pay an await to decide
    // whether the cache can answer.
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<TitleCacheFile>
      if (parsed.version !== 1 || parsed.sessions === null || typeof parsed.sessions !== 'object') return
      for (const [id, entry] of Object.entries(parsed.sessions)) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.builtAt !== 'number' || typeof entry.lastAccess !== 'number') continue
        this.entries.set(id, {
          ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
          ...(typeof entry.workspaceDir === 'string' ? { workspaceDir: entry.workspaceDir } : {}),
          builtAt: entry.builtAt,
          lastAccess: entry.lastAccess,
          ...(entry.ambiguous === true ? { ambiguous: true } : {}),
        })
      }
    } catch { /* absent or unreadable cache is simply empty */ }
  }

  /**
   * Read one entry, applying E4. A hit refreshes `lastAccess`; an expired entry
   * reports a miss so the caller re-reads it.
   *
   * @param sessionId - exact session id.
   * @param now - epoch ms used for the age check (injectable for tests).
   * @returns the live entry, or undefined on miss/expiry.
   */
  get(sessionId: string, now: number = Date.now()): TitleCacheEntry | undefined {
    this.load()
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined // E1
    if (now - entry.lastAccess > TITLE_TTL_MS) return undefined // E4
    if (entry.lastAccess !== now) {
      entry.lastAccess = now
      this.markDirty()
    }
    return entry
  }

  /**
   * Record a freshly read title (or the absence of one) for a session.
   *
   * @param sessionId - exact session id.
   * @param title - observed title, omitted when the log has none.
   * @param now - epoch ms stamped as both `builtAt` and `lastAccess`.
   * @param workspaceDir - listing workspace directory, when known.
   */
  set(sessionId: string, title: string | undefined, now: number = Date.now(), workspaceDir?: string): void {
    this.load()
    const previous = this.entries.get(sessionId)
    const dir = workspaceDir ?? previous?.workspaceDir
    this.entries.set(sessionId, {
      ...(title === undefined ? {} : { title }),
      ...(dir === undefined ? {} : { workspaceDir: dir }),
      builtAt: now,
      lastAccess: now,
      // A resolved ambiguity stays recorded until the entry is re-read.
      ...(previous?.ambiguous === true ? { ambiguous: true } : {}),
    })
    this.markDirty()
  }

  /** Record that one name mapped to more than one session (E2 marker). */
  markAmbiguous(sessionId: string, now: number = Date.now()): void {
    this.load()
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    if (entry.ambiguous === true) return
    entry.ambiguous = true
    entry.lastAccess = now
    this.markDirty()
  }

  /** E3: drop one entry so the next read re-reads it. */
  forget(sessionId: string): void {
    this.load()
    if (this.entries.delete(sessionId)) this.markDirty()
  }

  /** Exact-id lookup by name over cached entries (the hot addressing path). */
  findByName(name: string): string[] {
    this.load()
    const needle = name.trim().toLowerCase()
    if (needle.length === 0) return []
    const ids: string[] = []
    for (const [id, entry] of this.entries) {
      if (entry.ambiguous === true) continue
      if (entry.title?.trim().toLowerCase() === needle) ids.push(id)
    }
    return ids
  }

  /** Every cached entry, for callers that need the whole address book. */
  snapshot(): ReadonlyMap<string, TitleCacheEntry> {
    this.load()
    return this.entries
  }

  private markDirty(): void {
    this.dirty = true
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, TitleCache.FLUSH_DELAY_MS)
    // Never keep the process alive for a cache write.
    this.flushTimer.unref?.()
  }

  /** Persist pending state; atomic (tmp + rename). Safe to call repeatedly. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const filePath = this.filePath
    if (filePath === undefined) return
    const payload: TitleCacheFile = { version: 1, sessions: Object.fromEntries(this.entries) }
    try {
      await mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await writeFile(tmp, JSON.stringify(payload), 'utf8')
      await rename(tmp, filePath)
    } catch { /* a cache write failure must never surface to the caller */ }
  }

  /** Stop the debounce timer (tests). Pending state is flushed by the caller. */
  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }
}
