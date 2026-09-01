import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as toolsApply } from '../src/tools.ts'

describe('s2s tools', () => {
  it('registers the 5-tool family and disposes on teardown', async () => {
    const ctx = new Context()
    const registered: Array<{ name: string }> = []
    let disposer: () => void = () => {}
    ctx.provide('tools', { register: (d: { name: string }) => { registered.push(d); disposer = vi.fn(); return disposer } } as never)
    ctx.provide('s2sBroker', { deliver: vi.fn(), history: vi.fn(() => []) } as never)
    ctx.provide('s2sDiscovery', { list: async () => [], resolve: async () => ({ kind: 'not-found', name: 'x', candidates: [] }) } as never)
    await ctx.plugin(toolsApply)
    expect(registered.map(t => t.name)).toEqual(['s2s_peers', 's2s_sessions', 's2s_message', 's2s_resume', 's2s_history', 's2s_schedule'])
    await ctx.fiber.dispose()
    expect(disposer).toHaveBeenCalled()
  })
})

