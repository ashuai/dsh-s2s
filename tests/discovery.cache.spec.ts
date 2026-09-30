import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

function rec(id: string, cwd: string, live = false) { return { header: { id, cwd }, live } }

/** A sessionQuery stub that counts every read, so tests can assert "no read". */
function countingQuery(records: unknown[], titles: Record<string, string>) {
  const counts = { list: 0, readTitle: 0 }
  const query = {
    listSessions: async () => { counts.list += 1; return records },
    readTitle: async (id: unknown) => { counts.readTitle += 1; return titles[String(id)] !== undefined ? { title: titles[String(id)] } : undefined },
  }
  return { query, counts }
}

interface HarnessOptions {
  /** Ids whose cached row exists but holds no usable title. */
  projection?: {
    /** Mutable on purpose: a test may rewrite it to simulate a rename. */
    hits: Record<string, string>
    titleLess?: readonly string[]
    misses?: readonly string[]
    present?: boolean
    /** Ids whose title is only reachable through cachedPredecessorTitle. */
    predecessorOnly?: readonly string[]
  }
}

async function harness(records: unknown[], titles: Record<string, string>, opts: HarnessOptions = {}) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined })
  const { query, counts } = countingQuery(records, titles)
  ctx.provide('sessionQuery', query)
  if (opts.projection !== undefined && opts.projection.present !== false) {
    const hits = opts.projection.hits
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (meta: unknown, keys?: readonly string[]) => {
        const id = String((meta as { id: unknown }).id)
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
  await ctx.plugin(S2sDiscoveryService)
  return { d: ctx.get('s2sDiscovery') as S2sDiscoveryService, ctx, counts }
}

describe('s2s discovery capability layers', () => {
  it('L1: the projection cache answers without any sessionQuery title read', async () => {
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w')], {}, {
      projection: { hits: { a: '开发', b: '产品' } },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual(['开发', '产品'])
    expect(counts.readTitle).toBe(0)
  })

  it('L1 miss falls to one per-session read for each miss only', async () => {
    const { d, counts } = await harness([rec('a', '/w'), rec('b', '/w')], { b: '只有读取能给' }, {
      projection: { hits: { a: '甲' }, misses: ['b'] },
    })
    const list = await d.list()
    expect(list.map(s => s.title)).toEqual(['甲', '只有读取能给'])
    expect(counts.readTitle).toBe(1)
  })

  it('L1 absence of a title row is an answer, not a miss', async () => {
    const { d, counts } = await harness([rec('a', '/w')], { a: '读取不该被调用' }, {
      projection: { hits: {}, titleLess: ['a'] },
    })
    const list = await d.list()
    expect(list[0]!.title).toBeUndefined()
    expect(counts.readTitle).toBe(0)
  })

  it('host without a projection cache still resolves via L3', async () => {
    const { d, counts } = await harness([rec('a', '/w')], { a: '回退标题' }, {
      projection: { hits: {}, present: false },
    })
    const list = await d.list()
    expect(list[0]!.title).toBe('回退标题')
    expect(counts.readTitle).toBe(1)
  })

  it('L1 that throws is treated as a miss and never breaks enumeration', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessionQuery', { listSessions: async () => [rec('a', '/w')], readTitle: async () => undefined })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => { throw new Error('boom') },
      cachedPredecessorTitle: () => { throw new Error('boom') },
    })
    await ctx.plugin(S2sDiscoveryService)
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    await expect(d.list()).resolves.toHaveLength(1)
  })
})

// The bug this file exists to pin down: a local cache sat in front of the host's
// projection rows. It could not observe upstream changes, so once it held a
// session's old name it answered with that name indefinitely — the host had
// "新名" while s2s kept saying "旧名". Nothing may be remembered between calls.
describe('s2s discovery freshness', () => {
  it('reports a rename as soon as the host rows carry it', async () => {
    const hits: Record<string, string> = { a: '旧名' }
    const { d } = await harness([rec('a', '/w')], {}, { projection: { hits } })

    expect((await d.list())[0]!.title).toBe('旧名')

    hits.a = '新名' // the host checkpoints the rename
    expect((await d.list())[0]!.title).toBe('新名')
  })

  it('stops resolving the old name once the host carries the new one', async () => {
    const hits: Record<string, string> = { a: '旧名' }
    const { d } = await harness([rec('a', '/w')], {}, { projection: { hits } })

    expect((await d.resolve('旧名', undefined)).kind).toBe('ok')

    hits.a = '新名'
    expect((await d.resolve('旧名', undefined)).kind).toBe('not-found')
    expect((await d.resolve('新名', undefined)).kind).toBe('ok')
  })

  it('re-reads the host on every name resolution instead of answering from memory', async () => {
    const hits: Record<string, string> = { a: '名字' }
    const { d, counts } = await harness([rec('a', '/w')], {}, { projection: { hits } })

    await d.resolve('名字', undefined)
    await d.resolve('名字', undefined)
    expect(counts.list).toBe(2)
  })

  it('a first title appearing later is picked up', async () => {
    const hits: Record<string, string> = {}
    const { d } = await harness([rec('a', '/w')], {}, { projection: { hits, titleLess: [] } })

    expect((await d.list())[0]!.title).toBeUndefined()
    hits.a = '第一次命名'
    expect((await d.list())[0]!.title).toBe('第一次命名')
  })

  it('forgetCachedTitle stays callable and is a no-op', async () => {
    const { d } = await harness([rec('a', '/w')], {}, { projection: { hits: { a: '名字' } } })
    expect(() => d.forgetCachedTitle('a')).not.toThrow()
    expect((await d.list())[0]!.title).toBe('名字')
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
