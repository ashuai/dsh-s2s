/**
 * The session-lifecycle service: durable mailbox plus resume-and-deliver for
 * dormant (done) sessions. A message for a dormant session is enqueued; when
 * `autoResume: 'allow'` the service resumes the session through the agent
 * registry and drains the mailbox into it via the same idle-aware injection
 * the mesh uses. Resumed sessions are left live-idle on purpose — the
 * service never disposes an agent it resumed (see OQ-5: dispose semantics
 * are still under review; auto-sleeping a human's session is worse than
 * leaving it parked).
 * @module dsh-s2s/lifecycle
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { S2sError } from './error.ts'
import { S2sMailbox, type MailboxEntry } from './mailbox.ts'

/** Lifecycle knobs. */
export interface LifecycleConfig {
  /** Master switch; the entry plugin only mounts the service when set. */
  readonly enabled?: boolean
  /** Whether a queued message may resume the dormant session (default deny). */
  readonly autoResume?: 'allow' | 'deny'
  /** Mailbox root override; defaults to ~/.dsh/s2s/mailboxes. */
  readonly mailboxDir?: string
}

/** A minimal resumed-agent handle (structural; avoids coupling to internals). */
interface ResumedHandle {
  readonly agent: Agent
  readonly dispose?: () => void | Promise<void>
}

/**
 * The lifecycle service. Mounted only when a `lifecycle` config block is
 * present, so deployments that never target dormant sessions pay nothing.
 */
export class S2sLifecycleService extends Service {
  static inject = ['agents']

  private readonly config: LifecycleConfig
  private readonly mailbox: S2sMailbox
  /** Resumed handles are kept alive for the process lifetime (see OQ-5). */
  private readonly resumed = new Map<string, ResumedHandle>()
  private readonly offCreated: () => void

  constructor(ctx: Context, config: LifecycleConfig = {}) {
    super(ctx, 's2sLifecycle')
    this.config = config
    this.mailbox = new S2sMailbox(config.mailboxDir)
    // A wake can also arrive because someone manually reopened the session;
    // drain on agent creation so the queue clears no matter who resumed.
    this.offCreated = this.ctx.root.on('agent/created', ({ agent }) => {
      void this.drain(String(agent.id)).catch((error: unknown) => {
        this.ctx.logger.warn(`s2s lifecycle: drain failed for ${String(agent.id)}: ${String(error)}`)
      })
    })
    this.ctx.effect(() => this.offCreated, 's2sLifecycle.listener')
  }

  /**
   * Queue one message for a (presumed dormant) session and, when allowed,
   * resume it and deliver immediately.
   * @returns `'resumed'` when the session was resumed and drained now,
   *   `'queued'` when the entry waits in the mailbox.
   */
  async queueForDormant(entry: { sessionId: string; from: string; text: string; replyTo?: string; msgId: string }): Promise<'queued' | 'resumed'> {
    const record: MailboxEntry = {
      msgId: entry.msgId,
      from: entry.from,
      text: entry.text,
      ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo }),
      createdAt: Date.now(),
    }
    await this.mailbox.enqueue(entry.sessionId, record)
    if (this.config.autoResume !== 'allow') return 'queued'
    // Defensive: a live session must never be resumed again (duplicate
    // identity is rejected loud by the registry) — the mesh delivers live.
    if (this.ctx.agents.get(SessionId(entry.sessionId)) !== undefined) return 'queued'
    const registry = this.ctx.agents as typeof this.ctx.agents & {
      resume?: (options: { resumeSessionId: string }) => Promise<ResumedHandle>
    }
    if (typeof registry.resume !== 'function') {
      this.ctx.logger.warn('s2s lifecycle: agent registry has no resume capability; message stays queued')
      return 'queued'
    }
    const handle = await registry.resume({ resumeSessionId: entry.sessionId })
    this.resumed.set(entry.sessionId, handle)
    await this.drain(entry.sessionId)
    return 'resumed'
  }

  /**
   * Drain the mailbox into the live agent for one session. Delivered via
   * follow-up turn when idle, plain context injection when busy (same
   * idle-aware shape as mesh inbound). Public: tests and the resume tool
   * path call it directly after a wake.
   */
  async drain(sessionId: string): Promise<number> {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) return 0
    const entries = await this.mailbox.drain(sessionId)
    for (const entry of entries) {
      const text = `[s2s-lifecycle message] from=${entry.from} queued-at=${new Date(entry.createdAt).toISOString()} replyTo=${entry.replyTo ?? '-'}
${entry.text}`
      const userMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 's2s-lifecycle', msgId: entry.msgId },
      })
      if (agent.status === 'idle') {
        agent.followup(userMessage)
      } else {
        agent.inject(userMessage)
      }
    }
    return entries.length
  }

  /** Queued message count for one session (tool-facing). */
  async queuedCount(sessionId: string): Promise<number> {
    return this.mailbox.count(sessionId)
  }

  /** Reject unsafe ids early so tools can report a clean error. */
  static assertSafeSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new S2sError(`s2s lifecycle: unsafe session id ${JSON.stringify(sessionId)}`, 'S2S_LIFECYCLE')
    }
  }
}
