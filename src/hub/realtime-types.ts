/**
 * Realtime wire frames (protocol version 3): the client/server vocabulary
 * over the `/v1/connect` WebSocket. Text and attachment content travel as
 * encoded payloads; frames are plain JSON text.
 * @module @dpskh/a2a/hub/realtime-types
 */

import type { S2sMessageRequestTarget, S2sPeer, S2sRealtimeMessage } from './types.ts'
import type { EncodedAttachment, EncodedTextPayload } from './payload.ts'

/** The mesh protocol version this seam implements. */
export const S2S_PROTOCOL_VERSION = 3

/** One accepted send: the stored message plus the recipients at accept time. */
export type S2sAcceptedMessage = {
  readonly message: S2sRealtimeMessage
  readonly recipients: readonly string[]
}

/** Client→Hub frames. */
export type S2sClientFrame =
  | { type: 'hello'; protocolVersion: number; project: string; name: string }
  | {
    type: 'message'
    requestId: string
    messageId: string
    target: S2sMessageRequestTarget
    payload: EncodedTextPayload
    attachments: EncodedAttachment[]
    replyTo?: string
  }
  | { type: 'delivered'; messageId: string }
  | { type: 'delivery_failed'; messageId: string; error: string }

/** Hub→Client frames. */
export type S2sServerFrame =
  | {
    type: 'claimed'
    protocolVersion: typeof S2S_PROTOCOL_VERSION
    project: string
    self: S2sPeer
    peers: S2sPeer[]
  }
  | { type: 'presence_joined'; peer: S2sPeer }
  | {
    type: 'presence_left'
    peer: S2sPeer
    reason: 'connection_closed' | 'heartbeat_timeout' | 'hub_shutdown'
  }
  | { type: 'accepted'; requestId: string; message: S2sRealtimeMessage; recipients: string[] }
  | { type: 'message'; message: S2sRealtimeMessage }
  | ({ type: 'delivery' } & (
    | { messageId: string; to: string; status: 'delivered' | 'disconnected' }
    | { messageId: string; to: string; status: 'failed'; error: string }
  ))
  | { type: 'error'; code: string; message: string; requestId?: string }
