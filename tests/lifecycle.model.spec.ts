import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply, S2sLifecycleService } from '../src/index.ts'

// Spy on the exported installModelSelection so we can assert the lifecycle
// installs the agent-scoped model-selection hooks on resume and that the
// selection resolves the session's last model (binding {{model}}/{{provider}}).
const { installSpy } = vi.hoisted(() => ({ installSpy: vi.fn() }))
vi.mock('@deepseek-ai/dsh-agent', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-agent')>('@deepseek-ai/dsh-agent')
  return { ...actual, installModelSelection: installSpy as unknown as typeof actual.installModelSelection }
})

const dirs: string[] = []
afterEach(async () => {
  installSpy.mockClear()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function makeAgent(requestHeader?: { provider: string; model: string }) {
  const agentCtx = new Context()
  return {
    id: 'sess-1',
    status: 'idle',
    session: { requestHeader: () => (requestHeader === undefined ? undefined : { config: requestHeader }) },
    ctx: agentCtx,
    followup: () => {},
    inject: () => {},
  }
}

async function resumeOnce(requestHeader?: { provider: string; model: string }) {
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-lm-'))
  dirs.push(mailboxDir)
  const ctx = new Context()
  const agent = makeAgent(requestHeader)
  const resume = vi.fn(async () => ({ agent }))
  ctx.provide('agents', { get: () => undefined, resume } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'wake', msgId: 'm1' })
  return { resume, agent }
}

describe('s2s lifecycle model selection (the {{model}} fix)', () => {
  it('installs model selection on resume, binding the session model for {{model}}', async () => {
    const { resume, agent } = await resumeOnce({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: 'sess-1' })
    expect(installSpy).toHaveBeenCalledTimes(1)
    const [agentCtxArg, selection] = installSpy.mock.calls.at(-1)!
    expect(agentCtxArg).toBe(agent.ctx)
    // selection resolves the session's last model config
    expect(selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    // the mutable selection accepts a picked value (setter path)
    selection.current = { provider: 'zhipu-glm', model: 'glm-5.3-flash' }
    expect(selection.current).toEqual({ provider: 'zhipu-glm', model: 'glm-5.3-flash' })
  })

  it('leaves selection.current undefined when the session has no logged model', async () => {
    await resumeOnce(undefined)
    const [, selection] = installSpy.mock.calls.at(-1)!
    expect(selection.current).toBeUndefined()
  })
})
