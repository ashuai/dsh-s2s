/**
 * Model-facing s2s tools: peers (live), sessions (all w/ titles), message
 * (send / wake), resume (explicit wake), history (process-scoped).
 * @module dsh-s2s/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { S2sBroker } from './broker.ts'
import type { S2sDiscoveryService, S2sResolveResult, S2sSessionInfo } from './discovery.ts'
import { S2sLifecycleService } from './lifecycle.ts'
import type { S2sBudget, S2sThreadEntry } from './budget.ts'
import type { S2sScheduleService } from './schedule.ts'

function textRender(_args: object, value: { text: string }): ContentBlock[] {
  return [{ type: 'text', text: value.text }]
}

const OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const } } },
  render: textRender,
}

function labelOf(r: Extract<S2sResolveResult, { kind: 'ok' }>): string {
  return r.title ?? r.sessionId
}

function describeCandidates(cands: { title?: string; sessionId: string; state: string; workspaceDir: string }[]): string[] {
  return cands.map(function(c) { return '- ' + (c.title ?? '(untitled)') + ' [' + c.sessionId.slice(0, 8) + '] ' + c.state + ' ws=' + c.workspaceDir })
}

function displayResolve(resolved: Extract<S2sResolveResult, { kind: 'not-found' | 'ambiguous' }>): string {
  if (resolved.kind === 'not-found') {
    const lines = resolved.candidates.length === 0 ? ['No sessions match.'] : describeCandidates(resolved.candidates)
    return 'No session named "' + resolved.name + '" (renames take effect immediately; list actual names with s2s_sessions).\n' + lines.join('\n')
  }
  return 'Multiple sessions named "' + resolved.name + '". Disambiguate with session_id:\n' + resolved.candidates.map(function(c) { return '- ' + c.sessionId + ' (' + c.workspaceDir + ')' }).join('\n')
}

function buildThread(broker: S2sBroker, from: string, to: string): S2sThreadEntry[] {
  const records = [
    ...broker.history(to).filter((r) => r.from === from),
    ...broker.history(from).filter((r) => r.from === to),
  ]
  return records.sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ from: r.from, text: r.text, at: r.createdAt }))
}

function modelOf(exec: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const agent = (exec as { agent?: { session?: { requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string } } } } } | undefined)?.agent
  const cfg = agent?.session?.requestHeader?.()?.config
  if (cfg === undefined) return undefined
  return {
    ...(cfg.provider === undefined ? {} : { provider: cfg.provider }),
    ...(cfg.model === undefined ? {} : { model: cfg.model }),
    ...(cfg.reasoningEffort === undefined ? {} : { reasoningEffort: cfg.reasoningEffort }),
  }
}

function sameProjectAsCaller(infos: readonly S2sSessionInfo[], exec: unknown): readonly S2sSessionInfo[] {
  const callerId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id
  if (callerId === undefined) return infos
  const caller = infos.find((info) => info.sessionId === callerId)
  if (caller === undefined) return infos
  return infos.filter((info) => info.workspaceDir === caller.workspaceDir)
}

export function buildTools(deps: { broker: S2sBroker; discovery: S2sDiscoveryService; lifecycle?: S2sLifecycleService; budget?: S2sBudget; schedule?: S2sScheduleService }): ToolDefinition[] {
  const broker = deps.broker, discovery = deps.discovery, lifecycle = deps.lifecycle, budget = deps.budget, schedule = deps.schedule
  const resolve = async function(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult | { kind: 'err'; reason: string }> {
    if ((name === undefined || name.length === 0) && (sessionId === undefined || sessionId.length === 0)) {
      return { kind: 'err', reason: 'Provide a name (the session title) or a session_id.' }
    }
    return discovery.resolve(name, sessionId)
  }
  return [
    defineTool({
      name: 's2s_peers',
      description: 'List live sessions in the current project (all=true lists every project) with title (name) and state. Use the title in s2s_message / s2s_resume.',
      parameters: { all: { type: 'boolean', description: 'List sessions across all projects (default: current project only).' } },
      output: OUTPUT,
      execute: async function(args, exec) {
        const infos = await discovery.list()
        const scoped = args.all === true ? infos : sameProjectAsCaller(infos, exec)
        const sessions = scoped.filter(function(s) { return s.state !== 'dormant' })
        if (sessions.length === 0) return { text: 'No live sessions.' }
        return { text: sessions.map(function(s) { return (s.title ?? '(untitled)') + '  [' + s.sessionId.slice(0, 8) + ']  ' + s.state }).join('\n') }
      },
    }),
    defineTool({
      name: 's2s_sessions',
      description: 'List known sessions in the current project (all=true lists every project) with lifecycle state (live-idle/live-busy/dormant). Show title, short id, state. Use the title as the addr in s2s_message / s2s_resume.',
      parameters: {
        all: { type: 'boolean', description: 'List sessions across all projects (default: current project only).' },
        query: { type: 'string', description: 'Optional substring filter over session title, session id, or workspace directory name.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        const allInfos = await discovery.list()
        const scoped = args.all === true ? allInfos : sameProjectAsCaller(allInfos, exec)
        const sessions = (args.query === undefined || args.query.length === 0)
          ? scoped
          : scoped.filter(function(s) { const needle = (args.query as string).toLowerCase(); return (s.title ?? '').toLowerCase().includes(needle) || s.sessionId.toLowerCase().includes(needle) || s.workspaceDir.toLowerCase().includes(needle) })
        if (sessions.length === 0) return { text: 'No sessions found.' }
        return { text: sessions.map(function(s) { return (s.title ?? '(untitled)') + '  [' + s.sessionId.slice(0, 8) + ']  ' + s.state + '  ws=' + s.workspaceDir + (s.lastActivity === undefined ? '' : '  last=' + new Date(s.lastActivity).toISOString()) }).join('\n') }
      },
    }),
    defineTool({
      name: 's2s_message',
      description: 'Send a message to a session by its NAME (title, refreshed live) or session_id. Delivers immediately to a live session; to a dormant one it queues and, when lifecycle autoResume=allow, also resumes.',
      parameters: {
        name: { type: 'string', description: 'Target session title (from s2s_sessions). Primary addressing.' },
        session_id: { type: 'string', description: 'Fallback exact session id (when a name is ambiguous).' },
        text: { type: 'string', required: true, description: 'Message text.' },
        reply_to: { type: 'string', description: 'Optional context label for the receiver.' },
        from: { type: 'string', description: 'Optional sender label (defaults to your agent id).' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        const resolved = await resolve(args.name, args.session_id)
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        const from = args.from ?? String(exec.agent?.id ?? 'unknown')
        const msgId = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        let warn: string | undefined
        if (budget !== undefined) {
          const result = await budget.check(from, resolved.sessionId, 0, buildThread(broker, from, resolved.sessionId), modelOf(exec))
          if (result?.verdict === 'warn') warn = result.reason
        }
        if (resolved.state !== 'dormant') {
          const state = broker.deliver(resolved.sessionId, { from: from, text: args.text, msgId: msgId, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
          return { text: 'Delivered to "' + labelOf(resolved) + '" (state=' + state + ').' + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
        }
        if (lifecycle === undefined) return { text: '"' + labelOf(resolved) + '" is dormant and no lifecycle is configured; use s2s_resume with autoResume=allow to wake it.' }
        const outcome = await lifecycle.queueForDormant({ sessionId: resolved.sessionId, from: from, text: args.text, msgId: msgId, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
        const queued = await lifecycle.queuedCount(resolved.sessionId)
        const base = outcome === 'resumed' ? 'Woke "' + labelOf(resolved) + '" and delivered (queued: ' + queued + ').' : 'Queued for "' + labelOf(resolved) + '" (' + queued + ' total).'
        return { text: base + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
      },
    }),
    defineTool({
      name: 's2s_resume',
      description: 'Wake a dormant (done) session by NAME (title) or session_id and deliver one message. With autoResume=allow resumes immediately; with deny queues.',
      parameters: {
        name: { type: 'string', description: 'Target session title. Primary addressing.' },
        session_id: { type: 'string', description: 'Fallback exact session id when a name is ambiguous.' },
        text: { type: 'string', required: true, description: 'Message text to deliver after the wake.' },
        from: { type: 'string', description: 'Sender label.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        if (lifecycle === undefined) return { text: 's2s lifecycle is not configured: add a lifecycle config block to enable waking dormant sessions.' }
        const resolved = await resolve(args.name, args.session_id)
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        S2sLifecycleService.assertSafeSessionId(resolved.sessionId)
        const from = args.from ?? String(exec.agent?.id ?? 'unknown')
        const msgId = 'wake-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        const outcome = await lifecycle.queueForDormant({ sessionId: resolved.sessionId, from: from, text: args.text, msgId: msgId })
        const queued = await lifecycle.queuedCount(resolved.sessionId)
        return { text: outcome === 'resumed' ? 'Session "' + labelOf(resolved) + '" resumed and delivered (queued: ' + queued + ').' : 'Session "' + labelOf(resolved) + '" is dormant; queued (' + queued + ' total).' }
      },
    }),
    defineTool({
      name: 's2s_history',
      description: 'Recent messages for a session (process-scoped, not durable across restarts). Address by name or session_id.',
      parameters: {
        name: { type: 'string', description: 'Target session title.' },
        session_id: { type: 'string', description: 'Exact session id.' },
        limit: { type: 'number', description: 'Max messages (default 50).' },
      },
      output: OUTPUT,
      execute: async function(args) {
        const resolved = (args.name !== undefined || args.session_id !== undefined) ? await resolve(args.name, args.session_id) : { kind: 'err' as const, reason: 'Provide a name or session_id.' }
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        const records = broker.history(resolved.sessionId, args.limit === undefined ? {} : { limit: args.limit })
        if (records.length === 0) return { text: 'No recent messages.' }
        return { text: records.map(function(r) { return '[' + new Date(r.createdAt).toISOString() + '] ' + r.from + ' -> ' + r.text }).join('\n') }
      },
    }),
    defineTool({
      name: 's2s_schedule',
      description: 'Schedule a prompt to be injected into a session on a timer. action=list lists jobs; create (every_seconds periodic, or at_iso one-shot) schedules; cancel (job_id) removes one.',
      parameters: {
        action: { type: 'string', required: true, description: 'list | create | cancel' },
        text: { type: 'string', description: 'Prompt text to inject (create).' },
        every_seconds: { type: 'number', description: 'Periodic interval in seconds (create); <300 collapses to a one-shot at now+interval.' },
        at_iso: { type: 'string', description: 'One-shot ISO instant (create).' },
        session_id: { type: 'string', description: 'Target session (default: this session).' },
        job_id: { type: 'string', description: 'Job id to cancel.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        if (schedule === undefined) return { text: 's2s schedule is not configured: add a schedule config block to enable scheduled injection.' }
        if (args.action === 'list') {
          const jobs = await schedule.list()
          if (jobs.length === 0) return { text: 'No scheduled jobs.' }
          return { text: jobs.map(function(j) { return '- ' + j.id + ' [' + j.targetSessionId.slice(0, 8) + '] ' + (j.everySeconds !== undefined ? 'every ' + j.everySeconds + 's' : 'at ' + (j.atIso ?? '')) + (j.enabled ? '' : ' (disabled)') }).join('\n') }
        }
        if (args.action === 'create') {
          if (args.text === undefined || args.text.length === 0) return { text: 'create needs a text.' }
          const target = args.session_id ?? String(exec.agent?.id ?? '')
          if (target.length === 0) return { text: 'create needs a session_id (or run from a session).' }
          const job = await schedule.create({
            targetSessionId: target,
            text: args.text,
            ...(args.every_seconds === undefined ? {} : { everySeconds: args.every_seconds }),
            ...(args.at_iso === undefined ? {} : { atIso: args.at_iso }),
          })
          return { text: 'Scheduled ' + job.id + ' -> ' + target + ' ' + (job.everySeconds !== undefined ? 'every ' + job.everySeconds + 's' : 'at ' + (job.atIso ?? '')) + '.' }
        }
        if (args.action === 'cancel') {
          if (args.job_id === undefined || args.job_id.length === 0) return { text: 'cancel needs a job_id.' }
          const ok = await schedule.cancel(args.job_id)
          return { text: ok ? 'Cancelled ' + args.job_id + '.' : 'No job ' + args.job_id + '.' }
        }
        return { text: 'action must be list | create | cancel.' }
      },
    }),
  ]
}

/** Cordis plugin name of the tool family. */
export const name = 's2s-tools'

export const inject = ['s2sBroker', 's2sDiscovery', 'tools']

export function apply(ctx: Context): void {
  const tools = ctx.get('tools') as { register(definition: ToolDefinition): () => void }
  const broker = ctx.get('s2sBroker') as S2sBroker
  const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService | undefined
  const budget = ctx.get('s2sBudget') as S2sBudget | undefined
  const schedule = ctx.get('s2sSchedule') as S2sScheduleService | undefined
  const disposers = buildTools({ broker: broker, discovery: discovery, ...(lifecycle === undefined ? {} : { lifecycle: lifecycle }), ...(budget === undefined ? {} : { budget: budget }), ...(schedule === undefined ? {} : { schedule: schedule }) }).map(function(d) { return tools.register(d) })
  ctx.effect(function() { return function() { for (const d of disposers) d() } }, 's2s-tools.disposers')
}

