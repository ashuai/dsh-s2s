/**
 * `@dpskh/a2a` 0.3 — the realtime S2S mesh for the DeepSeek Harness, in one
 * package with one entry plugin. Mounting the plugin provides the mesh hub
 * host (`ctx.s2sHub`: project registry + immutable message history over the
 * storage domain, with an optional listening hub server that also serves
 * the realtime WebSocket) and the mesh client (`ctx.s2sMesh`: one
 * WebSocket presence per joined agent with serial injection), plus the
 * `s2s_peers` / `s2s_message` / `s2s_history` tools. Presence is a live
 * socket; messages are the durable record — realtime chat on a trusted
 * private network.
 * @module dsh-s2s — trimmed fork of @dpskh/a2a
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { S2sHubHostService, type S2sHubHostConfig } from './hub/host.ts'
import { S2sMeshService, type MeshConfig } from './mesh.ts'
import { S2sBudget, type BudgetConfig } from './budget.ts'
import { S2sLifecycleService, type LifecycleConfig } from './lifecycle.ts'
import { S2sDiscoveryService } from './discovery.ts'
import * as toolsPlugin from './tools.ts'

export { S2sError } from './error.ts'
export type { S2sErrorCode } from './error.ts'
// The standard-S2S spec constants (constants.ts) and the mesh protocol
// version (realtime-types.ts) both export `S2S_PROTOCOL_VERSION`, so the
// mesh version is re-exported under its own name and the spec pin wins the
// bare name (see constants.ts).
export { S2S_PROTOCOL_VERSION as MESH_PROTOCOL_VERSION } from './hub/realtime-types.ts'
export type {
  S2sClientFrame,
  S2sServerFrame,
  S2sAcceptedMessage,
} from './hub/realtime-types.ts'
export * from './hub/types.ts'
export * from './constants.ts'
export { s2sHubDomainSpec, compositeKey, KEY_SEP } from './hub/spec.ts'
export { S2sHubRegistry, ProjectConflictError, UnknownProjectError } from './hub/registry.ts'
export { S2sHubMessages, MessageIdConflictError, UnknownReplyTargetError, MAX_HISTORY_BYTES } from './hub/messages.ts'
export { S2sPresenceRegistry, NameInUseError } from './hub/presence.ts'
export type { S2sPresence } from './hub/presence.ts'
export { S2sHubServer, NAME_RE } from './hub/server.ts'
export { S2sHubClient, probeHub } from './hub/client.ts'
export type { HubMeta } from './hub/client.ts'
export { S2sConnection } from './hub/connection.ts'
export type { S2sConnectionEvents } from './hub/connection.ts'
export { S2sHubHostService } from './hub/host.ts'
export type { S2sHubHostConfig } from './hub/host.ts'
export { S2sMeshService } from './mesh.ts'
export { S2sBudget, BUDGET_DEFAULTS } from './budget.ts'
export type { BudgetConfig } from './budget.ts'
export { S2sMailbox } from './mailbox.ts'
export type { MailboxEntry } from './mailbox.ts'
export { S2sLifecycleService } from './lifecycle.ts'
export type { LifecycleConfig } from './lifecycle.ts'
export { S2sDiscoveryService, DEFAULT_SESSIONS_ROOT } from './discovery.ts'
export type { S2sSessionInfo } from './discovery.ts'
export type { MeshConfig, S2sChange, S2sMeshStatus, S2sMessageView, StoredConnection } from './mesh.ts'
export { DEFAULT_PROJECT, ASYNC_REPLY_GUIDANCE } from './mesh.ts'
export { snapshotAttachments, materializeAttachments } from './attachments.ts'
export type { S2sAttachmentReference } from './attachments.ts'
export { peerView } from './view.ts'
export type { S2sPeerActivity, S2sPeerView } from './view.ts'
export {
  encodeTextPayload,
  decodeTextPayload,
  encodeBinaryPayload,
  decodeBinaryPayload,
  parseEncodedAttachments,
  validateMessageContent,
  TEXT_PLAIN_LIMIT,
  DECODED_TEXT_LIMIT,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_ATTACHMENT_COUNT,
} from './hub/payload.ts'
export type { EncodedTextPayload, EncodedBinaryPayload, EncodedAttachment } from './hub/payload.ts'
export { formatMessageRef, parseMessageRef, PROJECT_NAME_RE, AGENT_NAME_RE } from './hub/message-ref.ts'
export { buildTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    s2sHub: S2sHubHostService
    s2sMesh: S2sMeshService
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-s2s'

/** Services the entry plugin itself consumes (children declare their own). */
export const inject: string[] = []

/** One plugin configuration: hub host, mesh client, and s2s lifecycle/budget. */
export interface Config {
  /**
   * Optional hub host. Providing the block mounts the hub service (registry
   * + history over the storage domain); providing `server` additionally
   * listens as the mesh hub (HTTP + realtime WebSocket).
   */
  readonly hub?: { server?: Omit<S2sHubHostConfig, 'port'> & { port: number } }
  /** Optional mesh client: connect one agent's presence on mount. */
  readonly mesh?: MeshConfig
  /** Optional lifecycle: mailbox + resume for dormant sessions (off when absent). */
  readonly lifecycle?: { enabled?: boolean; autoResume?: string; mailboxDir?: string }
  /** Optional sender-side anti-loop budget (off when absent). */
  readonly budget?: BudgetConfig
}

/** Config validator. */
export const Config: z<Config> = z.object({
  // schemastery object schemas default to `{}` when absent; the explicit
  // `default(undefined)` keeps the optional fields truly absent.
  hub: z.object({
    server: z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().required(),
      maxPort: z.number(),
    }),
  }).default(undefined as never),
  lifecycle: z.object({
    enabled: z.boolean(),
    autoResume: z.string(),
    mailboxDir: z.string(),
  }).default(undefined as never),
  budget: z.object({
    maxHops: z.number(),
    ratePerMinute: z.number(),
  }).default(undefined as never),
  mesh: z.object({
    hubUrl: z.string(),
    project: z.string(),
    name: z.string(),
    agentId: z.string(),
    autoConnect: z.boolean(),
    persistConnections: z.boolean(),
    reconnectMs: z.number(),
  }).default(undefined as never),
})

/**
 * Mount the whole S2S mesh: the hub host (when configured), the mesh
 * client (when configured), and the tool surface. Each child
 * plugin declares its own `inject`, so cordis activates them in dependency
 * order and owns their disposers (HMR-safe).
 * @param ctx - Cordis context.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.hub !== undefined) {
    // The hub service without a server config is a pure in-process hub
    // (registry + history, no listening socket) — the s2s default shape.
    ctx.plugin(S2sHubHostService, config.hub.server === undefined
      ? undefined
      : {
        ...(config.hub.server.host === undefined ? {} : { host: config.hub.server.host }),
        port: config.hub.server.port,
        ...(config.hub.server.maxPort === undefined ? {} : { maxPort: config.hub.server.maxPort }),
      })
  }
  if (config.budget !== undefined) {
    ctx.provide('s2sBudget', new S2sBudget(config.budget))
  }
  if (config.lifecycle !== undefined) {
    // Normalize at the boundary: any unknown autoResume value means deny —
    // waking a human's dormant session is the loud direction.
    ctx.plugin(S2sLifecycleService, {
      ...(config.lifecycle.enabled === undefined ? {} : { enabled: config.lifecycle.enabled }),
      autoResume: config.lifecycle.autoResume === 'allow' ? 'allow' : 'deny',
      ...(config.lifecycle.mailboxDir === undefined ? {} : { mailboxDir: config.lifecycle.mailboxDir }),
    })
  }
  if (config.mesh !== undefined) {
    ctx.plugin(S2sMeshService, config.mesh)
    // Session discovery backs the s2s_sessions tool; mounted with the mesh.
    ctx.plugin(S2sDiscoveryService)
    // The tool plugin declares the mesh, discovery, and registry services as
    // inject dependencies, so cordis activates them in the right order
    // with no timing coupling (the module object carries the `inject`
    // metadata the fiber resolves).
    ctx.plugin(toolsPlugin)
  }
}
