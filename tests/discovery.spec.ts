import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

const dirs: string[] = []
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
