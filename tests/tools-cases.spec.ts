import { describe, expect, it, vi } from 'vitest'
import { buildTools } from '../src/tools.ts'

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> | { text: string } }

function makeTools(overrides: Record<string, any> = {}) {
  const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]), ...(overrides.broker ?? {}) }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any),
    ...(overrides.discovery ?? {}),
  }
  const lifecycle = { queueForDormant: vi.fn(async () => 'resumed' as const), queuedCount: vi.fn(async () => 0), ...(overrides.lifecycle ?? {}) }
  const budget = { check: vi.fn(), ...(overrides.budget ?? {}) }
  const schedule = {
    list: vi.fn(async () => [] as any[]),
    create: vi.fn(async (input: any) => ({ ...input, id: 'sched-1', nextAt: Date.now() + 1000, enabled: true, createdAt: Date.now(), everySeconds: input.everySeconds, atIso: input.atIso }) as any),
    cancel: vi.fn(async () => true),
    ...(overrides.schedule ?? {}),
  }
  const defs = buildTools({ broker, discovery, lifecycle, budget, schedule } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { by, exec: { agent: { id: 'sess-a' } }, broker, discovery, lifecycle, budget, schedule, defs }
}

describe('s2s tools execution', () => {
  it('s2s_peers lists live only', async () => {
    const { by } = makeTools({ discovery: { list: vi.fn(async () => [
      { sessionId: 's1', title: 'a', state: 'live-idle', workspaceDir: 'ws' },
      { sessionId: 's2', title: 'b', state: 'dormant', workspaceDir: 'ws' },
    ]) } })
    const out = await by('s2s_peers').execute({}, { agent: { id: 'x' } })
    expect(out.text).toContain('a')
    expect(out.text).not.toContain('b')
  })
  it('s2s_peers none', async () => {
    const { by } = makeTools()
    const out = await by('s2s_peers').execute({}, {})
    expect(out.text).toBe('No live sessions.')
  })
  it('s2s_sessions lists with lastActivity', async () => {
    const { by } = makeTools({ discovery: { list: vi.fn(async () => [
      { sessionId: 's1', title: '', state: 'live-busy', workspaceDir: 'ws', lastActivity: 1700000000000 },
    ]) } })
    const out = await by('s2s_sessions').execute({ query: 'ws' }, {})
    expect(out.text).toContain('live-busy')
    expect(out.text).toContain('last=')
  })
  it('s2s_sessions empty', async () => {
    const { by } = makeTools()
    const out = await by('s2s_sessions').execute({}, {})
    expect(out.text).toBe('No sessions found.')
  })
  it('s2s_peers defaults to the caller project only', async () => {
    const { by } = makeTools({ discovery: { list: vi.fn(async () => [
      { sessionId: 'sess-a', title: 'me', state: 'live-idle', workspaceDir: 'proj-a' },
      { sessionId: 's1', title: 'a', state: 'live-idle', workspaceDir: 'proj-a' },
      { sessionId: 's2', title: 'b', state: 'live-idle', workspaceDir: 'proj-b' },
    ]) } })
    const out = await by('s2s_peers').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('a')
    expect(out.text).not.toContain('b')
  })
  it('s2s_peers all=true lists every project', async () => {
    const { by } = makeTools({ discovery: { list: vi.fn(async () => [
      { sessionId: 'sess-a', title: 'me', state: 'live-idle', workspaceDir: 'proj-a' },
      { sessionId: 's2', title: 'b', state: 'live-idle', workspaceDir: 'proj-b' },
    ]) } })
    const out = await by('s2s_peers').execute({ all: true }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('b')
  })
  it('s2s_sessions scopes to the caller project and respects all + query', async () => {
    const { by } = makeTools({ discovery: { list: vi.fn(async () => [
      { sessionId: 'sess-a', title: 'me', state: 'live-idle', workspaceDir: 'proj-a' },
      { sessionId: 's1', title: 'alpha', state: 'dormant', workspaceDir: 'proj-a' },
      { sessionId: 's2', title: 'beta', state: 'dormant', workspaceDir: 'proj-b' },
    ]) } })
    const scoped = await by('s2s_sessions').execute({ query: 'beta' }, { agent: { id: 'sess-a' } })
    expect(scoped.text).toBe('No sessions found.')
    const all = await by('s2s_sessions').execute({ query: 'beta', all: true }, { agent: { id: 'sess-a' } })
    expect(all.text).toContain('beta')
  })
  it('s2s_message no args -> err', async () => {
    const { by } = makeTools()
    const out = await by('s2s_message').execute({ text: 'hi' }, { agent: { id: 'x' } })
    expect(out.text).toContain('Provide a name')
  })
  it('s2s_message not-found', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'not-found', name: 'x', candidates: [] }) as any) } })
    const out = await by('s2s_message').execute({ name: 'x', text: 'hi' }, { agent: { id: 'y' } })
    expect(out.text).toContain('No session named')
  })
  it('s2s_message ambiguous', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'ambiguous', name: 'x', candidates: [{ sessionId: 's1', title: 'a', state: 'dormant', workspaceDir: 'ws' }] }) as any) } })
    const out = await by('s2s_message').execute({ name: 'x', text: 'hi' }, { agent: { id: 'y' } })
    expect(out.text).toContain('Multiple sessions')
  })
  it('s2s_message live delivers via broker', async () => {
    const deliver = vi.fn(() => 'busy' as const)
    const { by } = makeTools({ broker: { deliver, history: vi.fn(() => []) } })
    const out = await by('s2s_message').execute({ name: 'a', text: 'hi' }, { agent: { id: 'y' } })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(out.text).toContain('Delivered')
  })
  it('s2s_message dormant resumes', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 's1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) } })
    const { by: by2, lifecycle } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 's1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) } })
    const out = await by2('s2s_message').execute({ name: 'a', text: 'hi' }, { agent: { id: 'y' } })
    expect(lifecycle.queueForDormant).toHaveBeenCalledTimes(1)
    expect(out.text).toContain('Woke')
  })
  it('s2s_message dormant queued', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 's1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) }, lifecycle: { queueForDormant: vi.fn(async () => 'queued' as const), queuedCount: vi.fn(async () => 2) } })
    const out = await by('s2s_message').execute({ name: 'a', text: 'hi' }, { agent: { id: 'y' } })
    expect(out.text).toContain('Queued')
  })
  it('s2s_resume unconfigured', async () => {
    const defs = buildTools({ broker: { deliver: vi.fn(), history: vi.fn() }, discovery: { list: vi.fn(), resolve: vi.fn() } } as any)
    const tool = defs.find((d) => d.name === 's2s_resume') as unknown as Tool
    const out = await tool.execute({ name: 'a', text: 'hi' }, { agent: { id: 'y' } })
    expect(out.text).toContain('not configured')
  })
  it('s2s_resume dormant resumed', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 's1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) } })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'hi' }, { agent: { id: 'y' } })
    expect(out.text).toContain('resumed and delivered')
  })
  it('s2s_resume not-found', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'not-found', name: 'x', candidates: [] }) as any) } })
    const out = await by('s2s_resume').execute({ name: 'x', text: 'hi' }, { agent: { id: 'y' } })
    expect(out.text).toContain('No session named')
  })
  it('s2s_resume unsafe id throws', async () => {
    const { by } = makeTools({ discovery: { resolve: vi.fn(async () => ({ kind: 'ok', sessionId: '../evil', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) } })
    await expect(by('s2s_resume').execute({ name: 'a', text: 'hi' }, { agent: { id: 'y' } })).rejects.toThrow(/unsafe/)
  })
  it('s2s_history err no args', async () => {
    const { by } = makeTools()
    const out = await by('s2s_history').execute({}, {})
    expect(out.text).toContain('Provide a name')
  })
  it('s2s_history records', async () => {
    const { by } = makeTools({ broker: { deliver: vi.fn(), history: vi.fn(() => [{ createdAt: 1700000000000, from: 'a', text: 't' }]) } })
    const out = await by('s2s_history').execute({ name: 'a' }, {})
    expect(out.text).toContain('a -> t')
  })
  it('s2s_history empty', async () => {
    const { by } = makeTools()
    const out = await by('s2s_history').execute({ session_id: 's1' }, {})
    expect(out.text).toBe('No recent messages.')
  })
  it('s2s_schedule unconfigured', async () => {
    const defs = buildTools({ broker: { deliver: vi.fn(), history: vi.fn() }, discovery: { list: vi.fn(), resolve: vi.fn() } } as any)
    const tool = defs.find((d) => d.name === 's2s_schedule') as unknown as Tool
    const out = await tool.execute({ action: 'list' }, { agent: { id: 'y' } })
    expect(out.text).toContain('not configured')
  })
  it('s2s_schedule list empty', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'list' }, {})
    expect(out.text).toBe('No scheduled jobs.')
  })
  it('s2s_schedule list jobs', async () => {
    const { by } = makeTools({ schedule: { list: vi.fn(async () => [{ id: 'j1', targetSessionId: 's1', text: 't', everySeconds: 600, enabled: true, nextAt: 1, createdAt: 1 }]), create: vi.fn(), cancel: vi.fn() } })
    const out = await by('s2s_schedule').execute({ action: 'list' }, {})
    expect(out.text).toContain('j1')
    expect(out.text).toContain('every 600s')
  })
  it('s2s_schedule create every', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'create', text: 'do it', every_seconds: 600 }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('Scheduled')
    expect(out.text).toContain('every 600s')
  })
  it('s2s_schedule create at_iso', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'create', text: 'do it', at_iso: new Date(Date.now() + 60000).toISOString(), session_id: 's2' }, {})
    expect(out.text).toContain('at ')
  })
  it('s2s_schedule cancel ok', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'cancel', job_id: 'j1' }, {})
    expect(out.text).toContain('Cancelled')
  })
  it('s2s_schedule cancel missing', async () => {
    const { by } = makeTools({ schedule: { list: vi.fn(), create: vi.fn(), cancel: vi.fn(async () => false) } })
    const out = await by('s2s_schedule').execute({ action: 'cancel', job_id: 'j1' }, {})
    expect(out.text).toContain('No job')
  })
  it('s2s_schedule bad action', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'bogus' }, {})
    expect(out.text).toContain('action must be')
  })
  it('s2s_schedule create no text', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'create' }, { agent: { id: 'x' } })
    expect(out.text).toContain('create needs a text')
  })
  it('s2s_schedule create no target', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'create', text: 'x' }, {})
    expect(out.text).toContain('create needs a session_id')
  })
  it('s2s_schedule cancel no job_id', async () => {
    const { by } = makeTools()
    const out = await by('s2s_schedule').execute({ action: 'cancel' }, {})
    expect(out.text).toContain('cancel needs a job_id')
  })
})