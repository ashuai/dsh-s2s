import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { S2sDiscoveryService } from '../src/discovery.ts'

describe('REAL SessionStore + discovery', () => {
  it('creates a real session and discovery lists it by title + state', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
    ctx.storage.backend.register('sqlite', backend)
    const facility = new DomainFacility(ctx, { backend: 'sqlite' })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(SessionStore)
    ctx.sessions.create('sess-real')
    ctx.provide('agents', { get: () => undefined } as never)
    // sessionQuery 视图:把真实 store 的会话映射为记录 + 固定标题
    ctx.provide('sessionQuery', {
      listSessions: async () => (ctx.sessions.list() as unknown as Array<{ id: unknown; header?: { cwd?: string } }>).map(s => ({ header: { id: String(s.id), cwd: s.header?.cwd }, live: true })),
      readTitle: async () => ({ title: '部署员' }),
    } as never)
    await ctx.plugin(S2sDiscoveryService)
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const list = await d.list()
    expect(list.length).toBe(1)
    expect(list[0]!.sessionId).toBe('sess-real')
    expect(list[0]!.title).toBe('部署员')
    expect(list[0]!.state).toBe('dormant')
    await ctx.fiber.dispose()
  })
})

