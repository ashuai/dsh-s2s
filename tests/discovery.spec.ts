import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

function rec(id: string, cwd: string, live: boolean) { return { header: { id, cwd }, live } }
function sq(records: unknown[], titles: Record<string, string>) {
  return {
    listSessions: async () => records,
    readTitle: async (id: unknown) => titles[String(id)] !== undefined ? { title: titles[String(id)] } : undefined,
  }
}
async function harness(records: unknown[], agents: { get: (id: unknown) => { status: string } | undefined }, titles: Record<string, string>) {
  const ctx = new Context()
  ctx.provide('agents', agents)
  ctx.provide('sessionQuery', sq(records, titles))
  await ctx.plugin(S2sDiscoveryService)
  return ctx.get('s2sDiscovery') as S2sDiscoveryService
}

describe('s2s discovery', () => {
  it('lists live and dormant sessions with titles and states', async () => {
    const d = await harness(
      [rec('abc', '/w/a', false), rec('def', '/w/b', true)],
      { get: (id: unknown) => String(id) === 'def' ? { status: 'busy' } : undefined },
      { abc: '开发', def: '产品' },
    )
    const list = await d.list()
    expect(list.map(s => [s.sessionId, s.title, s.state])).toEqual([
      ['abc', '开发', 'dormant'],
      ['def', '产品', 'live-busy'],
    ])
  })

  it('resolves unique name, ambiguous duplicates, not-found with candidates', async () => {
    const d = await harness(
      [rec('a', '/w', false), rec('b', '/w', false)],
      { get: () => undefined },
      { a: '产品', b: '产品' },
    )
    expect((await d.resolve('产品', undefined)).kind).toBe('ambiguous')
    expect((await d.resolve('不存在', undefined)).kind).toBe('not-found')
    const ok = await harness([rec('c', '/w', false)], { get: () => undefined }, { c: '开发' }).then(x => x.resolve('开发', undefined))
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.sessionId).toBe('c')
  })

  it('matches by explicit session id too', async () => {
    const d = await harness([rec('c', '/w', false)], { get: () => undefined }, { c: '开发' })
    const ok = await d.resolve(undefined, 'c')
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.title).toBe('开发')
  })
})

