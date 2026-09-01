import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { S2sDiscoveryService } from '../src/discovery.ts'

async function harness(titles: Record<string,string>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessionTitle', { get: (s: {id:unknown}) => ({ title: titles[String(s.id)] ?? '(untitled)' }) } as never)
  await ctx.plugin(S2sDiscoveryService)
  return ctx
}

describe('REAL SessionStore + discovery', () => {
  it('creates a real session and discovery lists it by title + state', async () => {
    const ctx = await harness({ 'sess-real': '部署员' })
    ctx.sessions.create('sess-real')
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const list = await d.list()
    console.log('discovery list ids=', list.map(s=>s.sessionId), 'titles=', list.map(s=>s.title), 'states=', list.map(s=>s.state))
    expect(list.length).toBe(1)
    expect(list[0]!.sessionId).toBe('sess-real')
    expect(list[0]!.title).toBe('部署员')
    expect(list[0]!.state).toBe('dormant')
    await ctx.fiber.dispose()
  })
})

