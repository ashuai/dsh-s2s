/**
 * The in-process s2s broker: deliver a message straight into a live session
 * by its id, through the idle-aware injection idiom. No hub, no socket, no
 * network — both sessions live in this process and share the agent registry.
 * Also keeps a process-scoped message log for `s2s_history` (not durable).
 * @module dsh-s2s/broker
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { S2sError } from './error.ts'
import { S2S_SOURCE_KIND } from './constants.ts'

export interface S2sDeliverInput {
  from: string
  text: string
  msgId: string
  replyTo?: string
}

export interface S2sBrokerRecord extends S2sDeliverInput {
  sessionId: string
  createdAt: number
}

export type S2sDeliverState = 'idle' | 'busy' | 'absent'

export class S2sBroker extends Service {
  static inject = ['agents']

  private readonly records = new Map<string, S2sBrokerRecord[]>()
  private static readonly HISTORY_LIMIT = 200

  constructor(ctx: Context) {
    super(ctx, 's2sBroker')
  }

  /** The live agent for one session id, when registered. */
  liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  /**
   * Deliver one message into a live session: idle -> follow-up turn, busy ->
   * plain context injection. Returns the delivery state; 'absent' means no
   * live agent (caller should route to the lifecycle/mailbox path).
   */
  deliver(sessionId: string, input: S2sDeliverInput): S2sDeliverState {
    const agent = this.liveAgent(sessionId)
    if (agent === undefined) return 'absent'
    const text = `[s2s message] from=${input.from} at=${new Date().toISOString()}${input.replyTo ? ` replyTo=${input.replyTo}` : ''}
${input.text}`
    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: S2S_SOURCE_KIND, msgId: input.msgId },
    })
    if (agent.status === 'idle') agent.followup(userMessage)
    else agent.inject(userMessage)
    this.note(sessionId, input)
    return agent.status === 'idle' ? 'idle' : 'busy'
  }

  /** Recent process-scoped messages for one session (oldest last). */
  history(sessionId: string, opts: { limit?: number } = {}): S2sBrokerRecord[] {
    const limit = opts.limit ?? 50
    const records = this.records.get(sessionId) ?? []
    return records.slice(Math.max(0, records.length - limit))
  }

  private note(sessionId: string, input: S2sDeliverInput): void {
    const list = this.records.get(sessionId) ?? []
    list.push({ sessionId, ...input, createdAt: Date.now() })
    if (list.length > S2sBroker.HISTORY_LIMIT) list.splice(0, list.length - S2sBroker.HISTORY_LIMIT)
    this.records.set(sessionId, list)
  }

  static assertSafeSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new S2sError(`unsafe session id ${JSON.stringify(sessionId)}`, 'S2S_INVALID_MESSAGE')
    }
  }
}

