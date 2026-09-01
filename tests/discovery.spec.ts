import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

function session(id: string, cwd: string) { return { id, header: { cwd } } }
function titleService(titles: Record<string, string>) {
  return { get: (s: { id: unknown }) => ({ title: titles[String(s.id)] }) }
}

async function harness(sessions: unknown[], agents: { get: (id: unknown) => { status: string } | undefined }, titles: Record<string, string>) {
  const ctx = new Context()
  ctx.provide('agents', agents)
  ctx.provide('sessions', { list: () => sessions })
  ctx.provide('sessionTitle', titleService(titles))
  await ctx.plugin(S2sDiscoveryService)
  return ctx.get('s2sDiscovery') as S2sDiscoveryService
}

describe('s2s discovery', () => {
  it('lists sessions from the live store with titles and states', async () => {
    const d = await harness(
      [session('abc', '/w/a'), session('def', '/w/b')],
      { get: (id: unknown) => String(id) === 'def' ? { status: 'busy' } : undefined },
      { abc: '开发', def: '产品' },
    )
    const list = await d.list()
    expect(list.map(s => [s.sessionId, s.title, s.state])).toEqual([
      ['abc', '开发', 'dormant'],
      ['def', '产品', 'live-busy'],
    ])
  })

  it('resolves a unique name, ambiguous duplicates, and not-found with candidates', async () => {
    const d = await harness(
      [session('a', '/w'), session('b', '/w')],
      { get: () => undefined },
      { a: '产品', b: '产品' },
    )
    expect((await d.resolve('产品', undefined)).kind).toBe('ambiguous')
    expect((await d.resolve('不存在', undefined)).kind).toBe('not-found')
    const d2 = await harness([session('c', '/w')], { get: () => undefined }, { c: '开发' })
    const ok = await d2.resolve('开发', undefined)
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.sessionId).toBe('c')
  })

  it('matches by explicit session id too', async () => {
    const d = await harness([session('c', '/w')], { get: () => undefined }, { c: '开发' })
    const ok = await d.resolve(undefined, 'c')
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.title).toBe('开发')
  })
})

