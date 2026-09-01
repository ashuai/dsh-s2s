/**
 * The model-facing s2s tool family (0.3 realtime chat): `s2s_peers` lists
 * the current roster, `s2s_message` sends to one peer or broadcasts to the
 * project, and `s2s_history` reviews earlier project messages. Replies are
 * delivered passively — the tools never wait or poll.
 * @module @dpskh/a2a/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { S2sMeshService } from './mesh.ts'
import { ASYNC_REPLY_GUIDANCE } from './mesh.ts'
import type { S2sAttachmentReference } from './attachments.ts'
import { materializeAttachments } from './attachments.ts'
import type { S2sMessageView } from './mesh.ts'
import type { S2sBudget } from './budget.ts'
import { S2sLifecycleService } from './lifecycle.ts'
import type { S2sDiscoveryService } from './discovery.ts'

/** Render one tool result as plain text. */
function textRender(_args: object, value: { text: string }): ContentBlock[] {
  return [{ type: 'text', text: value.text }]
}

/** Format one message's attachments as model-visible lines. */
function formatAttachments(attachments: readonly S2sAttachmentReference[]): string {
  if (attachments.length === 0) return ''
  return `\nAttachments:\n${attachments
    .map(attachment => `- ${attachment.name} (${attachment.uncompressedBytes} bytes): ${attachment.path}`)
    .join('\n')}`
}

/** Format one history message like the injected inbound shape. */
function formatMessage(message: S2sMessageView, attachments: readonly S2sAttachmentReference[]): string {
  const target = message.target.type === 'project' ? 'project' : message.target.name
  return `[${message.messageRef}] ${message.from.name} -> ${target}${message.replyTo ? ` replyTo=${message.replyTo}` : ''}\n${message.text}${formatAttachments(attachments)}`
}

/**
 * Build the tool definitions over one mesh service.
 * @param mesh - the mesh client service.
 * @returns the tool definitions.
 */
export function buildTools(mesh: S2sMeshService, opts: { budget?: S2sBudget; lifecycle?: S2sLifecycleService; discovery?: S2sDiscoveryService } = {}): ToolDefinition[] {
  return [
    defineTool({
      name: 's2s_peers',
      description: 'List the exact S2S roster names currently present in this Project. Use only a returned name for target.type=agent.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: textRender,
      },
      // oxlint-disable-next-line typescript/require-await -- the execute contract is async; peers() is synchronous.
      execute: async (_args, exec) => {
        const peers = mesh.peers(exec.agent?.id)
        return {
          text: peers.length === 0
            ? 'No other Agents are present.'
            : peers.map(peer => peer.name).join('\n'),
        }
      },
    }),
    defineTool({
      name: 's2s_message',
      description: 'Send to one current peer or all current peers. Use target.type=agent with a name from s2s_peers, or target.type=project for all current peers. Set replyTo to reply to an earlier Project message. Attachments must be current-session file paths (absolute). '
        + ASYNC_REPLY_GUIDANCE,
      parameters: {
        target: {
          type: 'object',
          required: true,
          description: 'The message target: one current peer name, or the whole project.',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['agent', 'project'], required: true },
            name: { type: 'string', description: 'Peer roster name, from s2s_peers (required when type=agent).' },
          },
        },
        text: { type: 'string', required: true, description: 'The message text.' },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute file paths to attach; their bytes are snapshotted before sending.',
        },
        reply_to: { type: 'string', description: 'Optional Project message reference to reply to (e.g. demo:12).' },
        message_id: { type: 'string', description: 'Optional idempotency key; retrying the same id and body returns the original message.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: textRender,
      },
      execute: async (args, exec) => {
        const target = args.target
        const attachmentCount = args.attachments?.length ?? 0
        // Sender-side anti-loop budget (when a budget block is configured):
        // direct sends carry hop 0; relays are the lifecycle's concern.
        opts.budget?.check(String(exec.agent?.id ?? 'anonymous'), target.type === 'agent' ? String(target.name) : 'project', 0)
        const accepted = await mesh.message({
          ...(exec.agent === undefined ? {} : { from: String(exec.agent.id) }),
          target: target.type === 'project'
            ? { type: 'project' }
            : { type: 'agent', name: target.name as string },
          text: args.text,
          ...(args.attachments === undefined ? {} : { attachments: args.attachments }),
          ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(args.message_id === undefined ? {} : { messageId: args.message_id }),
        })
        const targetLabel = target.type === 'project'
          ? `${accepted.recipients.length} Agents`
          : target.name
        return {
          text: `Sent to ${targetLabel} ref=${accepted.message.messageRef} attachments=${attachmentCount}\n${ASYNC_REPLY_GUIDANCE}`,
        }
      },
    }),
    defineTool({
      name: 's2s_history',
      description: 'Review earlier Project messages using before, after, limit, or from. Returned attachment links are valid in the current session. Use only for past context; never wait or poll for new replies.',
      parameters: {
        before: { type: 'string', description: 'Only messages before this Project reference (exclusive).' },
        after: { type: 'string', description: 'Only messages after this Project reference (exclusive).' },
        limit: { type: 'number', description: 'Maximum messages (1–500, default 50).' },
        from: { type: 'string', description: 'Only messages from one roster name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: textRender,
      },
      execute: async (args, exec) => {
        const messages = await mesh.history(exec.agent?.id, {
          ...(args.before === undefined ? {} : { before: args.before }),
          ...(args.after === undefined ? {} : { after: args.after }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.from === undefined ? {} : { from: args.from }),
        })
        if (messages.length === 0) return { text: 'No messages.' }
        const formatted: string[] = []
        for (const message of messages) {
          const references = await materializeAttachments(message.project, message.messageRef, message.attachments)
          formatted.push(formatMessage(message, references))
        }
        return { text: formatted.join('\n\n') }
      },
    }),
    defineTool({
      name: 's2s_sessions',
      description: 'List known sessions with lifecycle state (live-idle / live-busy / dormant). Each row shows the session title (the user-facing name), its short id, and state. Use the title (name) as the addr in s2s_resume; never guess session ids.',
      parameters: {
        query: { type: 'string', description: 'Optional substring filter over session title, session id, or workspace directory name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: textRender,
      },
      execute: async (args) => {
        if (opts.discovery === undefined) return { text: 's2s discovery unavailable (mesh not mounted).' }
        const sessions = await opts.discovery.list(args.query)
        if (sessions.length === 0) return { text: 'No sessions found.' }
        return {
          text: sessions.map(session =>
            `${session.title ?? '(untitled)'}  [${session.sessionId.slice(0, 8)}]  ${session.state}  ws=${session.workspaceDir}${session.lastActivity === undefined ? '' : `  last=${new Date(session.lastActivity).toISOString()}`}`,
          ).join('\n'),
        }
      },
    }),
    defineTool({
      name: 's2s_resume',
      description: 'Wake a dormant (done) session by its NAME (the session title, refreshed live — renames always take effect) or by session_id. The message is queued durably; with lifecycle autoResume=allow the session is resumed and delivered immediately, with deny it waits in the mailbox. List names with s2s_sessions.',
      parameters: {
        name: { type: 'string', description: 'The target session title (from s2s_sessions). Primary addressing; user can rename any time. Use session_id to disambiguate a duplicate name.' },
        session_id: { type: 'string', description: 'Fallback exact session id (when a name is ambiguous).' },
        text: { type: 'string', required: true, description: 'The message text to deliver after the wake.' },
        from: { type: 'string', description: 'Optional sender label shown to the resumed session (defaults to your agent id).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: textRender,
      },
      execute: async (args, exec) => {
        if (opts.lifecycle === undefined) {
          return { text: 's2s lifecycle is not configured: add a lifecycle config block to enable waking dormant sessions.' }
        }
        if ((args.name === undefined || args.name.length === 0) && (args.session_id === undefined || args.session_id.length === 0)) {
          return { text: 'Provide a name (the session title) or a session_id.' }
        }
        const resolved = opts.discovery === undefined ? undefined : await opts.discovery.resolve(args.name, args.session_id)
        if (resolved === undefined) return { text: 's2s discovery unavailable (mesh not mounted).' }
        if (resolved.kind === 'not-found') {
          const lines = resolved.candidates.length === 0
            ? ['No sessions match.']
            : resolved.candidates.map(c => `- ${c.title ?? '(untitled)'} [${c.sessionId.slice(0, 8)}] ${c.state} ws=${c.workspaceDir}`)
          return { text: `No session named "${resolved.name}" (renames take effect immediately; list actual names with s2s_sessions).\n${lines.join('\n')}` }
        }
        if (resolved.kind === 'ambiguous') {
          return {
            text: `Multiple sessions named "${resolved.name}". Disambiguate with session_id:\n${resolved.candidates.map(c => `- ${c.sessionId} (${c.workspaceDir})`).join('\n')}`,
          }
        }
        S2sLifecycleService.assertSafeSessionId(resolved.sessionId)
        const msgId = `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const outcome = await opts.lifecycle.queueForDormant({
          sessionId: resolved.sessionId,
          from: args.from ?? String(exec.agent?.id ?? 'unknown'),
          text: args.text,
          msgId,
        })
        const queued = await opts.lifecycle.queuedCount(resolved.sessionId)
        const label = resolved.title ?? resolved.sessionId
        return {
          text: outcome === 'resumed'
            ? `Session "${label}" resumed and message delivered (still queued: ${queued}).`
            : `Session "${label}" is dormant; message queued (${queued} total). Delivery happens when the session is resumed (autoResume=allow) or reopened manually.`,
        }
      },
    }),
  ]
}

/** Cordis plugin name of the tool family. */
export const name = 's2s-tools'

/** The mesh, discovery, and tool registry services must be present first. */
export const inject = ['s2sMesh', 's2sDiscovery', 'tools']

/**
 * Register the s2s tool family on `ctx.tools`. Cordis activates this plugin
 * only after both the mesh service and the tool registry exist, so the
 * registration is timing-free.
 * @param ctx - Cordis context carrying the tool registry and mesh service.
 */
export function apply(ctx: Context): void {
  const tools = ctx.get('tools') as { register(definition: ToolDefinition): () => void }
  const mesh = ctx.get('s2sMesh') as S2sMeshService
  const budget = ctx.get('s2sBudget') as S2sBudget | undefined
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService | undefined
  const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService | undefined
  const disposers = buildTools(mesh, { ...(budget === undefined ? {} : { budget }), ...(lifecycle === undefined ? {} : { lifecycle }), ...(discovery === undefined ? {} : { discovery }) }).map(definition => tools.register(definition))
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 's2s-tools.disposers')
}
