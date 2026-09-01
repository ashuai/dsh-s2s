import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sBroker } from '../src/broker.ts'

function fakeAgent(status: string) {
  return { id: 's', status, followup: vi.fn(), inject: vi.fn() } as never
}

describe('s2s broker', () => {
  it('delivers idle via followup turn, busy via context inject, absent for unknown', async () => {
    const ctx = new Context()
    const idle = fakeAgent('idle')
    const busy = fakeAgent('busy')
    ctx.provide('agents', { get: (id: unknown) => String(id) === 'idle' ? idle : String(id) === 'busy' ? busy : undefined } as never)
    await ctx.plugin(S2sBroker)
    const broker = ctx.get('s2sBroker') as S2sBroker
    expect(broker.deliver('idle', { from: 'alice', text: 'hi', msgId: 'm1' })).toBe('idle')
    expect((idle as any).followup).toHaveBeenCalledTimes(1)
    expect((idle as any).inject).not.toHaveBeenCalled()
    expect(broker.deliver('busy', { from: 'alice', text: 'hi', msgId: 'm2' })).toBe('busy')
    expect((busy as any).inject).toHaveBeenCalledTimes(1)
    expect(broker.deliver('ghost', { from: 'alice', text: 'hi', msgId: 'm3' })).toBe('absent')
  })

  it('notes process-scoped history', async () => {
    const ctx = new Context()
    ctx.provide('agents', { get: (id: unknown) => String(id) === 's' ? fakeAgent('idle') : undefined } as never)
    await ctx.plugin(S2sBroker)
    const broker = ctx.get('s2sBroker') as S2sBroker
    broker.deliver('s', { from: 'alice', text: 'hello', msgId: 'm1' })
    const hist = broker.history('s')
    expect(hist).toHaveLength(1)
    expect(hist[0]!.text).toBe('hello')
  })

  it('formats replyTo and trims history beyond the internal limit', async () => {
    const ctx = new Context()
    const agent = fakeAgent('idle')
    ctx.provide('agents', { get: (id: unknown) => String(id) === 's' ? agent : undefined } as never)
    await ctx.plugin(S2sBroker)
    const broker = ctx.get('s2sBroker') as S2sBroker
    broker.deliver('s', { from: 'a', text: 'x', msgId: 'm1', replyTo: 'c-1' })
    const msg = (agent as any).followup.mock.calls[0][0]
    expect(String(msg.content[0].text)).toContain('replyTo=c-1')
    for (let i = 0; i < 210; i += 1) broker.deliver('s', { from: 'a', text: 't' + i, msgId: 'g' + i })
    expect(broker.history('s', { limit: 1000 })).toHaveLength(200)
  })

  it('accepts a safe session id', () => {
    expect(() => S2sBroker.assertSafeSessionId('sess-1')).not.toThrow()
  })
})

