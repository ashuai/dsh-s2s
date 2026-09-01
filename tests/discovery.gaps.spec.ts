import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

describe('s2s discovery gaps', () => {
  it('liveAgent returns the registered agent or undefined', async () => {
    const agent = { status: 'idle' }
    const ctx = new Context()
    ctx.provide('agents', { get: (id: unknown) => String(id) === 's1' ? agent : undefined } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService)
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    expect(d.liveAgent('s1')).toBe(agent)
    expect(d.liveAgent('zzz')).toBeUndefined()
    await ctx.fiber.dispose()
  })
  it('filters list by query, matching id when a title is absent', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [{ header: { id: 's1', cwd: '/w' }, live: false }], readTitle: async () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService)
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    expect(await d.list('s1')).toHaveLength(1)
    expect(await d.list('nomatch')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})