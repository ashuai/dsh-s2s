import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sScheduleService } from '../src/schedule.ts'
import '../src/types.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function makeService(agentsGet: (id: unknown) => unknown, lifecycle?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 's2s-sched-'))
  dirs.push(dir)
  const ctx = new Context()
  ctx.provide('agents', { get: agentsGet } as never)
  if (lifecycle !== undefined) ctx.provide('s2sLifecycle', lifecycle as never)
  await ctx.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
  const svc = ctx.get('s2sSchedule') as S2sScheduleService
  return { ctx, svc, dir }
}

function idleAgent() {
  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle' as const,
    session: { requestHeader: () => undefined } as never,
    ctx: new Context(),
    followup: (m: unknown) => { followups.push(m) },
    inject: () => {},
  }
  return { agent, followups }
}

function busyAgent() {
  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'running' as const,
    session: { requestHeader: () => undefined } as never,
    ctx: new Context(),
    followup: (m: unknown) => { followups.push(m) },
    inject: () => {},
  }
  return { agent, followups }
}

describe('s2s schedule service', () => {
  it('create + list + cancel round-trip', async () => {
    const { svc } = await makeService(() => undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'hello', everySeconds: 600 })
    expect(job.id).toMatch(/^sched-/)
    expect(job.enabled).toBe(true)
    expect(job.everySeconds).toBe(600)
    expect(job.nextAt).toBeGreaterThan(Date.now())
    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.text).toBe('hello')
    expect(await svc.cancel(job.id)).toBe(true)
    expect(await svc.cancel(job.id)).toBe(false)
    expect(await svc.list()).toHaveLength(0)
  })

  it('create validates inputs', async () => {
    const { svc } = await makeService(() => undefined)
    await expect(svc.create({ id: '../evil', targetSessionId: 'sess-1', text: 'x', everySeconds: 600 })).rejects.toThrow(/unsafe schedule id/)
    await expect(svc.create({ targetSessionId: '../evil', text: 'x', everySeconds: 600 })).rejects.toThrow(/unsafe target session/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: '', everySeconds: 600 })).rejects.toThrow(/must not be empty/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: 'x' })).rejects.toThrow(/exactly one/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 600, atIso: new Date(Date.now() + 60000).toISOString() })).rejects.toThrow(/exactly one/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 0 })).rejects.toThrow(/positive/)
  })

  it('sub-5-minute everySeconds collapses to a one-shot at', async () => {
    const { svc } = await makeService(() => undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 60 })
    expect(job.everySeconds).toBeUndefined()
    expect(job.atIso).toBeDefined()
  })

  it('tick retries a one-shot whose target is busy, then injects once idle (regression)', async () => {
    const { agent, followups } = busyAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'must-land', atIso: new Date(Date.now() - 1000).toISOString() })
    // busy: not injected, not dropped, next fire pushed forward
    expect(await svc.tick(Date.now())).toBe(0)
    expect(followups).toHaveLength(0)
    let after = (await svc.list())[0]!
    expect(after.enabled).toBe(true)
    const retryAt = after.nextAt
    // target becomes idle: the one-shot lands exactly once then retires
    agent.status = 'idle'
    expect(await svc.tick(retryAt + 1)).toBe(1)
    expect(followups).toHaveLength(1)
    after = (await svc.list())[0]!
    expect(after.enabled).toBe(false)
  })
  it('tick injects into an idle target via followup', async () => {
    const { agent, followups } = idleAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'run it', everySeconds: 600 })
    const now = job.nextAt + 1
    expect(await svc.tick(now)).toBe(1)
    expect(followups).toHaveLength(1)
    const msg = followups[0] as { content: { text: string }[]; source: { kind: string } }
    expect(msg.source.kind).toBe('s2s-schedule')
    expect(msg.content[0]!.text).toContain('run it')
    expect(msg.content[0]!.text).toContain('[s2s schedule]')
  })

  it('tick pushes a busy target forward without injecting', async () => {
    const { agent, followups } = busyAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 600 })
    const now = job.nextAt + 1
    expect(await svc.tick(now)).toBe(0)
    expect(followups).toHaveLength(0)
    const after = (await svc.list())[0]!
    expect(after.nextAt).toBe(now + 600000)
  })

  it('tick delegates an absent (dormant) target to the lifecycle when mounted', async () => {
    const q = vi.fn(async () => 'resumed')
    const { svc } = await makeService(() => undefined, { queueForDormant: q })
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'wake me', everySeconds: 600 })
    expect(await svc.tick(job.nextAt + 1)).toBe(1)
    expect(q).toHaveBeenCalledTimes(1)
    expect(q.mock.calls[0]![0]).toMatchObject({ sessionId: 'sess-1', from: 's2s-schedule', text: 'wake me' })
  })

  it('tick retries (never drops) a one-shot whose target is absent with no lifecycle', async () => {
    const { svc } = await makeService(() => undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'once', atIso: new Date(Date.now() - 1000).toISOString() })
    expect(await svc.tick(Date.now())).toBe(0)
    const after = (await svc.list())[0]!
    expect(after.enabled).toBe(true) // not dropped; retried
    expect(after.nextAt).toBeGreaterThan(Date.now())
  })

  it('a one-shot idle target fires once then disables', async () => {
    const { agent, followups } = idleAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'once', atIso: new Date(Date.now() - 1000).toISOString() })
    expect(await svc.tick(Date.now())).toBe(1)
    expect(followups).toHaveLength(1)
    const after = (await svc.list())[0]!
    expect(after.enabled).toBe(false)
  })

  it('reloads persisted jobs on a fresh instance (replay)', async () => {
    const { svc, dir } = await makeService(() => undefined)
    await svc.create({ targetSessionId: 'sess-1', text: 'persist', everySeconds: 600 })
    const ctx2 = new Context()
    ctx2.provide('agents', { get: () => undefined } as never)
    await ctx2.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const svc2 = ctx2.get('s2sSchedule') as S2sScheduleService
    expect(await svc2.list()).toHaveLength(1)
    expect((await svc2.list())[0]!.text).toBe('persist')
  })

  it('skips a corrupt job file on load', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { svc, dir } = await makeService(() => undefined)
    await writeFile(join(dir, 'bad.json'), 'not json', 'utf8')
    const ctx2 = new Context()
    ctx2.provide('agents', { get: () => undefined } as never)
    await ctx2.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const svc2 = ctx2.get('s2sSchedule') as S2sScheduleService
    expect(await svc2.list()).toHaveLength(0)
  })
})
