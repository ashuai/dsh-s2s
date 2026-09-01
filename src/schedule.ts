/**
 * Session-scoped scheduled prompt injection (execution semantics).
 *
 * A lightweight self-built scheduler, deliberately decoupled from the official
 * `@deepseek-ai/dsh-schedule` (which is reminder semantics): a job targets a
 * session, fires on a period or at a wall-clock time, and injects a prompt
 * through the idle-aware idiom. Jobs are durable (JSON files) and replayed on
 * mount. Cross-session wake delegates to the s2s lifecycle.
 * @module dsh-s2s/schedule
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { S2sError } from './error.ts'
import type { S2sLifecycleService } from './lifecycle.ts'

/** One scheduled job. */
export interface ScheduleJob {
  readonly id: string
  readonly targetSessionId: string
  /** The prompt text injected when the job fires. */
  readonly text: string
  /** Periodic interval (seconds). Mutually exclusive with `atIso`. */
  readonly everySeconds?: number
  /** One-shot wall-clock ISO instant. Mutually exclusive with `everySeconds`. */
  readonly atIso?: string
  /** Next fire time (epoch ms); maintained on every write. */
  nextAt: number
  enabled: boolean
  readonly createdAt: number
}

/** Schedule knobs. */
export interface ScheduleConfig {
  /** Job persistence dir; defaults to ~/.dsh/s2s/schedules. */
  readonly dir?: string
  /** Auto-timer interval (ms). 0 disables the timer (tests call tick()). */
  readonly timerIntervalMs?: number
}

/** Job ids become file names. */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Sub-5-minute periodic intervals collapse to a one-shot `at`. */
const MIN_PERIODIC_SECONDS = 300

/** A durable schedule: id-addressed jobs, replayed on mount, fired by tick(). */
export class S2sScheduleService extends Service {
  static inject = ['agents']

  private readonly dir: string
  private readonly timerIntervalMs: number
  private readonly jobs = new Map<string, ScheduleJob>()
  private readonly ready: Promise<void>
  private lifecycle?: S2sLifecycleService
  private timer?: ReturnType<typeof setInterval>

  constructor(ctx: Context, config: ScheduleConfig = {}) {
    super(ctx, 's2sSchedule')
    const home = process.env.DSH_HOME
    this.dir = config.dir ?? (home !== undefined && home.length > 0 ? join(home, '.dsh', 's2s', 'schedules') : join(homedir(), '.dsh', 's2s', 'schedules'))
    this.timerIntervalMs = config.timerIntervalMs ?? 30_000
    // Optional dependency: the s2s lifecycle, when mounted, handles the
    // dormant-wake path for a scheduled target that is no longer live.
    ctx.inject(['s2sLifecycle'], (sctx) => {
      this.lifecycle = (sctx as unknown as { s2sLifecycle: S2sLifecycleService }).s2sLifecycle
    })
    this.ready = this.load()
    if (this.timerIntervalMs > 0) {
      this.timer = setInterval(() => { void this.tick(Date.now()).catch((error: unknown) => { this.ctx.logger.warn('s2s schedule: tick failed: ' + String(error)) }) }, this.timerIntervalMs)
      this.timer.unref?.()
    }
    this.ctx.effect(() => () => { if (this.timer !== undefined) clearInterval(this.timer) }, 's2sSchedule.timer')
  }

  /** Create (or replace by id) a job and persist it. */
  async create(input: {
    id?: string
    targetSessionId: string
    text: string
    everySeconds?: number
    atIso?: string
  }): Promise<ScheduleJob> {
    await this.ready
    const id = input.id ?? 'sched-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    if (!JOB_ID_RE.test(id)) throw new S2sError('unsafe schedule id ' + JSON.stringify(id), 'S2S_SCHEDULE')
    if (!SESSION_ID_RE.test(input.targetSessionId)) throw new S2sError('unsafe target session id ' + JSON.stringify(input.targetSessionId), 'S2S_SCHEDULE')
    if (input.text.length === 0) throw new S2sError('schedule text must not be empty', 'S2S_SCHEDULE')
    const hasEvery = input.everySeconds !== undefined
    const hasAt = input.atIso !== undefined
    if (hasEvery === hasAt) throw new S2sError('schedule needs exactly one of everySeconds or atIso', 'S2S_SCHEDULE')
    if (hasEvery) { const v = input.everySeconds!; if (v <= 0) throw new S2sError('schedule everySeconds must be positive', 'S2S_SCHEDULE') }
    const now = Date.now()
    let everySeconds = input.everySeconds
    let atIso = input.atIso
    // Sub-5-minute "periodic" collapses to a one-shot at now+interval.
    if (everySeconds !== undefined && everySeconds < MIN_PERIODIC_SECONDS) {
      atIso = new Date(now + everySeconds * 1000).toISOString()
      everySeconds = undefined
    }
    const nextAt = atIso !== undefined ? Date.parse(atIso) : now + everySeconds! * 1000
    const job: ScheduleJob = {
      id,
      targetSessionId: input.targetSessionId,
      text: input.text,
      ...(everySeconds === undefined ? {} : { everySeconds }),
      ...(atIso === undefined ? {} : { atIso }),
      nextAt,
      enabled: true,
      createdAt: now,
    }
    this.jobs.set(id, job)
    await this.persist(job)
    return { ...job }
  }

  /** All jobs, oldest created first (copy). */
  async list(): Promise<ScheduleJob[]> {
    await this.ready
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt).map((j) => ({ ...j }))
  }

  /** Cancel one job; returns whether it existed. */
  async cancel(id: string): Promise<boolean> {
    await this.ready
    const job = this.jobs.get(id)
    if (job === undefined) return false
    this.jobs.delete(id)
    await rm(this.fileFor(id), { force: true }).catch(() => undefined)
    return true
  }

  /**
   * Fire every due job at `nowMs`. idle -> follow-up turn; busy -> push the
   * next fire forward (no interruption); absent (dormant) -> delegate to the
   * s2s lifecycle when mounted, else push forward. Returns the number fired.
   * Public: tests call it with a fixed clock; the auto-timer just calls it.
   */
  async tick(nowMs: number): Promise<number> {
    await this.ready
    let fired = 0
    for (const job of [...this.jobs.values()]) {
      if (!job.enabled || job.nextAt > nowMs) continue
      const agent = this.ctx.agents.get(SessionId(job.targetSessionId))
      const step = job.everySeconds !== undefined ? job.everySeconds * 1000 : undefined
      if (agent === undefined) {
        if (this.lifecycle !== undefined) {
          await this.lifecycle.queueForDormant({ sessionId: job.targetSessionId, from: 's2s-schedule', text: job.text, msgId: 'sched-' + job.id + '-' + nowMs })
          fired += 1
        }
        await this.advance(job, nowMs, step)
        continue
      }
      if (agent.status !== 'idle') {
        await this.advance(job, nowMs, step)
        continue
      }
      this.inject(agent, job, nowMs)
      fired += 1
      if (job.everySeconds !== undefined) {
        await this.advance(job, nowMs, step)
      } else {
        job.enabled = false
        job.nextAt = 0
        await this.persist(job)
      }
    }
    return fired
  }

  /** Push a recurring job forward, or retire a one-shot that could not fire. */
  private async advance(job: ScheduleJob, nowMs: number, step: number | undefined): Promise<void> {
    if (step !== undefined) {
      job.nextAt = nowMs + step
    } else if (nowMs > job.nextAt) {
      job.enabled = false
      job.nextAt = 0
    }
    await this.persist(job)
  }

  /** idle -> followed-up with the schedule framing. */
  private inject(agent: Agent, job: ScheduleJob, nowMs: number): void {
    const text = '[s2s schedule] job=' + job.id + ' at=' + new Date(nowMs).toISOString() + '\n' + job.text
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 's2s-schedule', jobId: job.id },
    })
    agent.followup(message)
  }

  private async load(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(this.dir, name)
      try {
        const job = JSON.parse(await readFile(file, 'utf8')) as ScheduleJob
        if (typeof job?.id === 'string' && typeof job?.targetSessionId === 'string') this.jobs.set(job.id, job)
      } catch { /* skip a corrupt job file */ }
    }
  }

  private fileFor(id: string): string {
    return join(this.dir, id + '.json')
  }

  private async persist(job: ScheduleJob): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = this.fileFor(job.id)
    const tmp = file + '.tmp'
    await writeFile(tmp, JSON.stringify(job), 'utf8')
    await rename(tmp, file)
  }
}