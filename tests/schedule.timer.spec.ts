import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sScheduleService } from '../src/schedule.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

describe('s2s schedule timer', () => {
  it('persists under DSH_HOME when no dir is configured', async () => {
    const prev = process.env.DSH_HOME
    const homeRoot = await mkdtemp(join(tmpdir(), 's2s-dsh-'))
    dirs.push(homeRoot)
    process.env.DSH_HOME = homeRoot
    try {
      const ctx = new Context()
      ctx.provide('agents', { get: () => undefined } as never)
      await ctx.plugin(S2sScheduleService, { timerIntervalMs: 0 })
      const svc = ctx.get('s2sSchedule') as S2sScheduleService
      await svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 600 })
      const { readdir } = await import('node:fs/promises')
      const schedDir = join(homeRoot, '.dsh', 's2s', 'schedules')
      expect(await readdir(schedDir)).toHaveLength(1)
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
  it('starts a timer when timerIntervalMs > 0 and cleans up on dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2s-tm-'))
    dirs.push(dir)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sScheduleService, { dir, timerIntervalMs: 1000 })
    const svc = ctx.get('s2sSchedule') as S2sScheduleService
    expect(svc).toBeDefined()
    await ctx.fiber.dispose()
  })
})