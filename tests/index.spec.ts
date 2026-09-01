import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

describe('s2s entry apply config gating', () => {
  it('mounts budget and schedule when configured', async () => {
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-idx-'))
    dirs.push(mailboxDir)
    const ctx = new Context()
    ctx.provide('tools', { register: vi.fn(() => () => {}) } as never)
    ctx.provide('agents', { get: () => undefined, resume: vi.fn() } as never)
    ctx.provide('sessions', { list: () => [] } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
    await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir }, budget: {}, schedule: { timerIntervalMs: 0 } })
    expect(ctx.get('s2sBroker')).toBeDefined()
    expect(ctx.get('s2sDiscovery')).toBeDefined()
    expect(ctx.get('s2sBudget')).toBeDefined()
    expect(ctx.get('s2sSchedule')).toBeDefined()
    expect(ctx.get('s2sLifecycle')).toBeDefined()
    await ctx.fiber.dispose()
  })
})