import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

function rec(id: string, cwd = '/w') { return { header: { id, cwd }, live: false } }

interface Harness {
  records: unknown[]
  readTitle: (id: unknown) => Promise<{ title?: string } | undefined>
  listSessions?: () => Promise<unknown[]>
}
async function harness(opts: Harness) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessionQuery', {
    listSessions: opts.listSessions ?? (async () => opts.records),
    readTitle: opts.readTitle,
  } as never)
  await ctx.plugin(S2sDiscoveryService)
  return { d: ctx.get('s2sDiscovery') as S2sDiscoveryService, ctx }
}

describe('s2s discovery perf', () => {
  it('resolve(sessionId) reads only that one title, not the whole corpus', async () => {
    let reads = 0
    const { d, ctx } = await harness({
      records: [rec('a'), rec('b'), rec('c')],
      readTitle: async (id) => { reads += 1; return String(id) === 'b' ? { title: '产品' } : undefined },
    })
    const ok = await d.resolve(undefined, 'b')
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.title).toBe('产品')
    expect(reads).toBe(1)
    await ctx.fiber.dispose()
  })

  it('coalesces concurrent collects onto a single scan', async () => {
    let listCalls = 0
    let reads = 0
    const { d, ctx } = await harness({
      records: [],
      listSessions: async () => { listCalls += 1; await new Promise(r => setTimeout(r, 20)); return [rec('a')] },
      readTitle: async () => { reads += 1; return undefined },
    })
    await Promise.all([d.list(), d.list(), d.list()])
    expect(listCalls).toBe(1)
    expect(reads).toBe(1)
    await ctx.fiber.dispose()
  })

  it('reads every title and preserves record order under bounded concurrency', async () => {
    const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']
    const { d, ctx } = await harness({ records: ids.map(id => rec(id)), readTitle: async (id) => ({ title: 'T-' + String(id) }) })
    const list = await d.list()
    expect(list.map(s => s.sessionId)).toEqual(ids)
    expect(list.map(s => s.title)).toEqual(ids.map(id => 'T-' + id))
    await ctx.fiber.dispose()
  })

  it('re-scans after a scan settles (titles are not TTL-cached)', async () => {
    let listCalls = 0
    const { d, ctx } = await harness({
      records: [],
      listSessions: async () => { listCalls += 1; return [rec('a')] },
      readTitle: async () => undefined,
    })
    await d.list()
    await d.list()
    expect(listCalls).toBe(2)
    await ctx.fiber.dispose()
  })
})
