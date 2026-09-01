import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

const dirs: string[] = []

/** Write a session log (plain jsonl) with an optional latest title. */
async function seedSession(root: string, workspace: string, sessionId: string, title?: string): Promise<void> {
  const dir = join(root, workspace, `session-${sessionId}`)
  await mkdir(dir, { recursive: true })
  let log = '{"type":"session","cwd":"/x"}\n'
  if (title !== undefined) log += `{"type":"session/title","data":{"title":${JSON.stringify(title)},"from":"user"}}\n`
  await writeFile(join(dir, 'session.jsonl'), log, 'utf8')
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('s2s discovery', () => {
  it('merges the live registry with the dormant store', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await mkdir(join(root, 'ws-a', 'session-abc'), { recursive: true })
    await mkdir(join(root, 'ws-b', 'session-def'), { recursive: true })
    await utimes(join(root, 'ws-a', 'session-abc'), 1000, 1000)
    await utimes(join(root, 'ws-b', 'session-def'), 2000, 2000)
    const ctx = new Context()
    ctx.provide('agents', { get: (id: unknown) => String(id) === 'def' ? { status: 'busy' } : undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const sessions = await discovery.list()
    expect(sessions.map(session => [session.sessionId, session.state])).toEqual([
      ['def', 'live-busy'],
      ['abc', 'dormant'],
    ])
    expect(sessions[1]!.workspaceDir).toBe('ws-a')
  })

  it('reads each session title fresh from its log', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await seedSession(root, 'ws-a', 'abc', '开发')
    await seedSession(root, 'ws-b', 'def')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const sessions = await discovery.list()
    expect(sessions.find(s => s.sessionId === 'abc')!.title).toBe('开发')
    expect(sessions.find(s => s.sessionId === 'def')!.title).toBeUndefined()
  })

  it('resolves a unique name to its session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await seedSession(root, 'ws-a', 'abc', '开发')
    await seedSession(root, 'ws-b', 'def', '产品')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const resolved = await discovery.resolve('开发', undefined)
    expect(resolved.kind).toBe('ok')
    if (resolved.kind === 'ok') expect(resolved.sessionId).toBe('abc')
  })

  it('reports an ambiguous name and never guesses', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await seedSession(root, 'ws-a', 'abc', '同名')
    await seedSession(root, 'ws-b', 'def', '同名')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const resolved = await discovery.resolve('同名', undefined)
    expect(resolved.kind).toBe('ambiguous')
    if (resolved.kind === 'ambiguous') expect(resolved.candidates).toHaveLength(2)
  })

  it('returns not-found with candidates for an unknown name', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await seedSession(root, 'ws-a', 'abc', '开发')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const resolved = await discovery.resolve('不存在', undefined)
    expect(resolved.kind).toBe('not-found')
    if (resolved.kind === 'not-found') expect(resolved.candidates[0]!.sessionId).toBe('abc')
  })

  it('reflects a rename immediately (fresh title read)', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await seedSession(root, 'ws-a', 'abc', '旧名')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    expect((await discovery.resolve('旧名', undefined)).kind).toBe('ok')
    // 写入一个新标题(模拟用户改名)后,旧名失效、新名生效
    await seedSession(root, 'ws-a', 'abc', '新名')
    expect((await discovery.resolve('旧名', undefined)).kind).toBe('not-found')
    expect((await discovery.resolve('新名', undefined)).kind).toBe('ok')
  })

  it('filters by substring over session id or workspace dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-disc-'))
    dirs.push(root)
    await mkdir(join(root, 'ws-a', 'session-abc'), { recursive: true })
    await mkdir(join(root, 'ws-b', 'session-def'), { recursive: true })
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
    const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
    expect((await discovery.list('abc')).map(session => session.sessionId)).toEqual(['abc'])
    expect((await discovery.list('ws-b')).map(session => session.sessionId)).toEqual(['def'])
    expect(await discovery.list('nope')).toEqual([])
  })
})
