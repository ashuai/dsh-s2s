import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply, S2sLifecycleService } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(autoResume: 'allow' | 'deny') {
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-life-'))
  dirs.push(mailboxDir)
  const ctx = new Context()
  const followups: unknown[] = []
  const injections: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle',
    // The lifecycle installs agent-scoped model selection on resume; give the
    // fake the minimal session + scoped ctx that path touches.
    session: { requestHeader: () => undefined },
    ctx: new Context(),
    followup: (message: unknown) => { followups.push(message) },
    inject: (message: unknown) => { injections.push(message) },
  }
  let live = false
  const resume = vi.fn(async () => {
    live = true
    return { agent, dispose: vi.fn() }
  })
  ctx.provide('agents', {
    get: (id: unknown) => live && String(id) === 'sess-1' ? agent : undefined,
    resume,
  } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume, mailboxDir } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  return { ctx, lifecycle, resume, followups, injections, setLive: (value: boolean) => { live = value } }
}

describe('s2s lifecycle', () => {
  it('queues, resumes, and drains when autoResume=allow', async () => {
    const { lifecycle, resume, followups } = await harness('allow')
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hello dormant', msgId: 'm1' })
    expect(outcome).toBe('resumed')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: 'sess-1' })
    expect(followups).toHaveLength(1)
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('[s2s-lifecycle message]')
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('hello dormant')
    expect(await lifecycle.queuedCount('sess-1')).toBe(0)
  })

  it('only queues when autoResume=deny', async () => {
    const { lifecycle, resume } = await harness('deny')
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hold', msgId: 'm1' })
    expect(outcome).toBe('queued')
    expect(resume).not.toHaveBeenCalled()
    expect(await lifecycle.queuedCount('sess-1')).toBe(1)
  })

  it('delivers to an already-live session instead of stalling (never re-resumes)', async () => {
    const { lifecycle, resume, setLive, followups } = await harness('allow')
    setLive(true)
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hi', msgId: 'm1' })
    expect(outcome).toBe('resumed')
    expect(resume).not.toHaveBeenCalled() // live session: never resume again
    expect(followups).toHaveLength(1) // delivered to the live idle agent
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('hi')
    expect(await lifecycle.queuedCount('sess-1')).toBe(0) // no leftover
  })

  it('rejects unsafe session ids loud', async () => {
    const { lifecycle } = await harness('deny')
    await expect(lifecycle.queueForDormant({ sessionId: '../evil', from: 'a', text: 't', msgId: 'm' })).rejects.toThrow(/unsafe/)
  })

  it('queues when the agent registry has no resume capability', async () => {
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-life-'))
    dirs.push(mailboxDir)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never) // no resume
    await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir } })
    const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'x', msgId: 'm' })
    expect(outcome).toBe('queued')
  })
})
