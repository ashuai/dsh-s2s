import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply } from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  const registered: Array<{ name: string }> = []
  ctx.provide('tools', { register: (d: { name: string }) => { registered.push(d); return () => {} } } as never)
  const agent = { id: 'sess-1', status: 'idle', followup: vi.fn(), inject: vi.fn() }
  ctx.provide('agents', { get: (id: unknown) => String(id) === 'sess-1' ? agent : undefined } as never)
  ctx.provide('sessions', { list: () => [] } as never)
  ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'deny' } })
  return { ctx, registered, agent }
}

describe('s2s composition', () => {
  it('mounts broker + discovery and registers 5 tools', async () => {
    const { ctx, registered } = await harness()
    expect(ctx.get('s2sBroker')).toBeDefined()
    expect(ctx.get('s2sDiscovery')).toBeDefined()
    expect(registered.map(t => t.name)).toEqual(['s2s_peers', 's2s_sessions', 's2s_message', 's2s_resume', 's2s_history'])
    await ctx.fiber.dispose()
  })
})

