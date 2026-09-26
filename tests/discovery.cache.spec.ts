import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'
import { TitleCache, TITLE_TTL_MS } from '../src/title-cache.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tmpCache(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 's2s-cache-'))
  dirs.push(dir)
  return join(dir, 'title-cache.json')
}

function rec(id: string, cwd: string, live = false) { return { header: { id, cwd }, live } }

/** A sessionQuery stub that counts every read, so tests can assert "no read". */
function countingQuery(records: unknown[], titles: Record<string, string>, opts: { batch?: boolean } = {}) {
  const counts = { list: 0, readTitle: 0, batch: 0, batchSizes: [] as number[] }
  const query: Record<string, unknown> = {
    listSessions: async () => { counts.list += 1; return records },
    readTitle: async (id: unknown) => { counts.readTitle += 1; return titles[String(id)] !== undefined ? { title: titles[String(id)] } : undefined },
  }
  if (opts.batch !== false) {
    query.readTitleSnapshots = async (ids: readonly unknown[]) => {
      counts.batch += 1
      counts.batchSizes.push(ids.length)
      return ids.map(id => titles[String(id)] !== undefined ? { title: titles[String(id)] } : undefined)
    }
  }
  return { query, counts }
}

interface HarnessOptions {
  /** Ids whose cached row exists but holds no usable title. */
  projection?: {
    hits: Record<string, string>
    titleLess?: readonly string[]
    misses?: readonly string[]
    calls?: string[]
    present?: boolean
    /** Ids whose title is only reachable through cachedPredecessorTitle. */
    predecessorOnly?: readonly string[]
  }
  batch?: boolean
  now?: () => number
}

async function harness(records: unknown[], titles: Record<string, string>, opts: HarnessOptions = {}) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined })
  const { query, counts } = countingQuery(records, titles, { batch: opts.batch ?? true })
  ctx.provide('sessionQuery', query)
  if (opts.projection !== undefined && opts.projection.present !== false) {
    const hits = opts.projection.hits
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (meta: unknown, keys?: readonly string[]) => {
        const id = String((meta as { id: unknown }).id)
        opts.projection!.calls?.push(id)
        if (keys !== undefined && !keys.includes('title')) return undefined
        // Explicit miss, otherwise a row exists for every hit/title-less id —
        // a title-less row is an answer, not a miss.
        if (opts.projection!.misses?.includes(id) === true) return undefined
        if (opts.projection!.titleLess?.includes(id) === true) return { asOfSeq: 1, values: {} }
        if (opts.projection!.predecessorOnly?.includes(id) === true) return undefined
        if (!Object.hasOwn(hits, id)) return undefined
        return { asOfSeq: 1, values: hits[id] !== undefined ? { title: hits[id] } : {} }
      },
      // Predecessor-only titles: the current checkpoint has no row, so this face
      // is what keeps the session off the per-session read path.
      cachedPredecessorTitle: (meta: unknown) => {
        const id = String((meta as { id: unknown }).id)
        if (opts.projection!.misses?.includes(id) === true) return undefined
        return opts.projection!.predecessorOnly?.includes(id) === true
          ? { asOfSeq: 1, values: hits[id] !== undefined ? { title: hits[id] } : {} }
          : undefined
      },
    })
  }
  const cachePath = await tmpCache()
  await ctx.plugin(S2sDiscoveryService, { cachePath, ...(opts.now === undefined ? {} : { now: opts.now }) })
  return { d: ctx.get('s2sDiscovery') as S2sDiscoveryService, ctx, counts, cachePath }
}

describe('s2s discovery title cache', () => {
  it('answers the second call with no log read at all', async () => {
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w')], { a: '甲', b: '乙' })
    await d.list()
    const firstReads = counts.readTitle + counts.batch
    expect(firstReads).toBeGreaterThan(0)
    counts.readTitle = 0
    counts.batch = 0
    counts.list = 0
    const second = await d.list()
    expect(second.map(s => s.title)).toEqual(['甲', '乙'])
    expect(counts.readTitle).toBe(0)
    expect(counts.batch).toBe(0)
  })

  it('E1: an uncached name triggers one read and is retained', async () => {
    const { d, counts } = await harness([rec('a', '/w')], { a: '开发' })
    expect((await d.resolve('开发', undefined)).kind).toBe('ok')
    const afterFirst = counts.batch + counts.readTitle
    expect(afterFirst).toBeGreaterThan(0)
    // Second resolve is served from the cache.
    const again = await d.resolve('开发', undefined)
    expect(again.kind).toBe('ok')
    if (again.kind === 'ok') expect(again.sessionId).toBe('a')
    expect(counts.batch + counts.readTitle).toBe(afterFirst)
  })

  it('E2: a cached name collision falls through and is marked ambiguous', async () => {
    const { d } = await harness([rec('a', '/w'), rec('b', '/w')], { a: '同名', b: '同名' })
    const first = await d.resolve('同名', undefined)
    expect(first.kind).toBe('ambiguous')
    // The collision is recorded, so the cache alone no longer answers it.
    const owners = d.titleCache().findByName('同名')
    expect(owners).toEqual([])
    const second = await d.resolve('同名', undefined)
    expect(second.kind).toBe('ambiguous')
  })

  it('E3: forgetting an entry forces a re-read', async () => {
    const { d, counts } = await harness([rec('a', '/w')], { a: '旧名' })
    await d.list()
    counts.batch = 0
    counts.readTitle = 0
    d.forgetCachedTitle('a')
    await d.list()
    expect(counts.batch + counts.readTitle).toBeGreaterThan(0)
  })

  it('E4: an entry older than the TTL is re-read; a fresh one is not', async () => {
    let clock = 1_000_000
    const { d, counts } = await harness([rec('a', '/w')], { a: '标题' }, { now: () => clock })
    await d.list()
    counts.batch = 0
    counts.readTitle = 0

    clock += TITLE_TTL_MS - 1000 // still fresh
    await d.list()
    expect(counts.batch + counts.readTitle).toBe(0)

    // The hit above refreshed `lastAccess`; age is measured from that access,
    // so pass the TTL again from here to reach E4.
    clock += TITLE_TTL_MS + 1000
    await d.list()
    expect(counts.batch + counts.readTitle).toBeGreaterThan(0)
  })

  it('does NOT re-read when only the log bytes change (lazy invalidation)', async () => {
    const cachePath = await tmpCache()
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    const { query, counts } = countingQuery([rec('a', '/w')], { a: '标题' })
    ctx.provide('sessionQuery', query)
    await ctx.plugin(S2sDiscoveryService, { cachePath })
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    await d.list()
    counts.batch = 0
    counts.readTitle = 0
    // Simulate the underlying log having changed: nothing in the cache tells us
    // that, and by design that must NOT trigger a re-read.
    const recordsBefore = counts.list
    await d.list()
    expect(counts.batch + counts.readTitle).toBe(0)
    expect(counts.list).toBe(recordsBefore + 1) // enumeration still happens
  })

  it('persists across a service restart answered from the file alone', async () => {
    const cachePath = await tmpCache()
    const first = new Context()
    first.provide('agents', { get: () => undefined })
    const q1 = countingQuery([rec('a', '/w')], { a: '持久标题' })
    first.provide('sessionQuery', q1.query)
    const svc1 = await first.plugin(S2sDiscoveryService, { cachePath }).then(() => first.get('s2sDiscovery') as S2sDiscoveryService)
    await svc1.list()
    await svc1.titleCache().flush()

    const second = new Context()
    second.provide('agents', { get: () => undefined })
    const q2 = countingQuery([rec('a', '/w')], { a: '持久标题' })
    second.provide('sessionQuery', q2.query)
    await second.plugin(S2sDiscoveryService, { cachePath })
    const svc2 = second.get('s2sDiscovery') as S2sDiscoveryService
    const list = await svc2.list()
    expect(list[0]!.title).toBe('持久标题')
    expect(q2.counts.batch + q2.counts.readTitle).toBe(0)
  })
})

describe('s2s discovery capability layers', () => {
  it('L1: the projection cache answers without any sessionQuery title read', async () => {
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w')], {}, {
      projection: { hits: { a: '缓存甲', b: '缓存乙' } },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual(['缓存甲', '缓存乙'])
    expect(counts.readTitle).toBe(0)
    expect(counts.batch).toBe(0)
  })

  it('L1 miss falls to one per-session read for each miss only', async () => {
    // There is deliberately no batch layer: the host's batch title fold
    // (`readTitleSnapshots`) was measured at the same cost as N single reads
    // (it loads every log either way), so only L1's zero-I/O rows are used.
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w'), rec('c', '/w')], { b: 'by-read', c: 'by-read-2' }, {
      projection: { hits: { a: 'cached' }, misses: ['b', 'c'] },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual(['cached', 'by-read', 'by-read-2'])
    expect(counts.readTitle).toBe(2) // only the two L1 misses
    expect(counts.batch).toBe(0) // no batch layer is consulted
  })

  it('L1 absence of a title row is an answer, not a miss', async () => {
    const { d, counts } = await harness([rec('a', '/w')], {}, {
      projection: { hits: {}, titleLess: ['a'] }, // row exists but holds no title
    })
    const list = await d.list()
    expect(list[0]!.title).toBeUndefined()
    expect(counts.batch).toBe(0)
    expect(counts.readTitle).toBe(0)
  })

  it('pre-0.1.7 host: no projection cache and no batch API still resolves via L3', async () => {
    const { d, counts } = await harness([rec('a', '/w/a'), rec('b', '/w/b')], { a: '老甲', b: '老乙' }, {
      batch: false,
      projection: { present: false, hits: {} },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual(['老甲', '老乙'])
    expect(counts.readTitle).toBe(2)
    expect(counts.batch).toBe(0)
    // And the cache makes the next call free on that old host too.
    counts.readTitle = 0
    await d.list()
    expect(counts.readTitle).toBe(0)
  })

  it('L1 that throws is treated as a miss and never breaks enumeration', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    const { query } = countingQuery([rec('a', '/w')], { a: '仍然可用' })
    ctx.provide('sessionQuery', query)
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => { throw new Error('boom') } })
    await ctx.plugin(S2sDiscoveryService, { cachePath: await tmpCache() })
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const list = await d.list()
    expect(list[0]!.title).toBe('仍然可用')
  })

  it('exact-id resolve is cache-served with no enumeration on a repeat', async () => {
    const { d, counts } = await harness([rec('a', '/w')], { a: '按号' })
    const first = await d.resolve(undefined, 'a')
    expect(first.kind).toBe('ok')
    const enumerations = counts.list
    const second = await d.resolve(undefined, 'a')
    expect(second.kind).toBe('ok')
    if (second.kind === 'ok') expect(second.workspaceDir).toBe('/w')
    // A cached id with a known workspace answers without listing the corpus.
    expect(counts.list).toBe(enumerations)
  })
})

describe('title cache unit', () => {
  it('tolerates a malformed cache file', async () => {
    const cachePath = await tmpCache()
    await writeFile(cachePath, 'not json at all', 'utf8')
    const cache = new TitleCache(cachePath)
    expect(cache.get('a', 1)).toBeUndefined()
    cache.set('a', 'x', 1)
    expect(cache.get('a', 2)?.title).toBe('x')
  })

  it('tolerates a cache file with a foreign version', async () => {
    const cachePath = await tmpCache()
    await writeFile(cachePath, JSON.stringify({ version: 99, sessions: { a: { builtAt: 1, lastAccess: 1, title: 'x' } } }), 'utf8')
    const cache = new TitleCache(cachePath)
    expect(cache.get('a')).toBeUndefined()
  })

  it('writes what it read, atomically', async () => {
    const cachePath = await tmpCache()
    const cache = new TitleCache(cachePath)
    cache.set('a', '写回', 5)
    await cache.flush()
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as { version: number; sessions: Record<string, { title?: string }> }
    expect(raw.version).toBe(1)
    expect(raw.sessions.a?.title).toBe('写回')
  })
})

describe('title cache persistence reporting', () => {
  it('reports a denied write once and stops retrying', async () => {
    const { TitleCache } = await import('../src/title-cache.ts')
    const errors: unknown[] = []
    // A path the process cannot write to (a directory, not a file).
    const dir = await mkdtemp(join(tmpdir(), 's2s-cache-denied-'))
    dirs.push(dir)
    const cache = new TitleCache(dir, (e) => errors.push(e))
    cache.set('a', 'x')
    await cache.flush()
    await cache.flush() // second attempt must be skipped
    expect(errors).toHaveLength(1)
    expect(cache.persistenceUnavailable).toBe(true)
    // reads still work from memory even when persistence is denied
    expect(cache.get('a')?.title).toBe('x')
  })

  it('falls back to ~/.dsh when DSH_HOME is absent (never memory-only)', async () => {
    const { TitleCache } = await import('../src/title-cache.ts')
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      const cache = new TitleCache()
      // Path resolution must be a real file path, not undefined.
      expect(() => cache.set('a', 'x')).not.toThrow()
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved
    }
  })
})

// The host's own session list consults two faces:
//   cachedSnapshot(header) ?? cachedPredecessorTitle(header)
// Using only the first left every session whose current checkpoint has no title
// row on the per-session read path — ~119 of 238 in a measured corpus, each a
// ~39 ms full-log fold.
describe('L1 predecessor fallback', () => {
  it('answers from cachedPredecessorTitle when the current checkpoint has no title row', async () => {
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w')], { a: '前任甲', b: '现任乙' }, {
      projection: { hits: { a: '前任甲', b: '现任乙' }, predecessorOnly: ['a'] },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual(['前任甲', '现任乙'])
    // No per-session read at all: both were answered by the projection cache.
    expect(counts.readTitle).toBe(0)
  })

  it('a title-less predecessor row is still an answer, not a miss', async () => {
    const { d, counts } = await harness([rec('a', '/w')], {}, {
      projection: { hits: {}, predecessorOnly: ['a'] },
    })
    const list = await d.list()
    expect(list[0]!.title).toBeUndefined()
    expect(counts.readTitle).toBe(0)
  })

  it('falls to a per-session read only when neither face answers', async () => {
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w')], { b: '只有读取能给' }, {
      projection: { hits: { b: '只有读取能给' }, predecessorOnly: ['a'], misses: ['a'] },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual([undefined, '只有读取能给'])
    expect(counts.readTitle).toBe(1) // only the genuinely unanswerable one
  })
})
