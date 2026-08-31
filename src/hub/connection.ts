/**
 * One realtime client connection: the WebSocket half of the mesh protocol.
 * The connection owns the hello handshake, the presence roster, the
 * request/response correlation for sends, and serialized inbound message
 * delivery (a message is acknowledged only after the consumer's handler
 * resolves — a throwing handler reports `delivery_failed` to the hub).
 * @module @dpskh/a2a/hub/connection
 */

import WebSocket, { type RawData } from 'ws'
import { S2sError, type S2sErrorCode } from '../error.ts'
import { encodeTextPayload } from './payload.ts'
import {
  S2S_PROTOCOL_VERSION,
  type S2sAcceptedMessage,
  type S2sClientFrame,
  type S2sServerFrame,
} from './realtime-types.ts'
import type {
  S2sDeliveryEvent,
  S2sMessageRequestTarget,
  S2sPeer,
  S2sRealtimeMessage,
} from './types.ts'
import type { EncodedAttachment } from './payload.ts'

/** Decode one ws message payload to text (text frames arrive as Buffer on Node). */
function frameText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(new Uint8Array(data)).toString('utf8')
}

/** Cap delivery-failure error text sent back to the hub. */
function deliveryFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (Buffer.byteLength(message, 'utf8') <= 512) return message || 'receiver failed to inject message'
  return Buffer.from(message, 'utf8')
    .subarray(0, 512)
    .toString('utf8')
    .replace(/\uFFFD$/, '')
}

/** Map a realtime error frame onto the seam's stable error vocabulary. */
function connectionError(code: string, message: string): S2sError {
  const mapped: S2sErrorCode = code === 'protocol_mismatch'
    ? 'S2S_PROTOCOL_MISMATCH'
    : code === 'name_in_use'
      ? 'S2S_NAME_IN_USE'
      : code === 'unknown_project'
        ? 'S2S_UNKNOWN_PROJECT'
        : 'S2S_CLAIM_REJECTED'
  return new S2sError(message, mapped)
}

/** Connection event callbacks. */
export interface S2sConnectionEvents {
  onPresenceJoined?: (peer: S2sPeer) => void
  onPresenceLeft?: (peer: S2sPeer, reason: Extract<S2sServerFrame, { type: 'presence_left' }>['reason']) => void
  onMessage?: (message: S2sRealtimeMessage) => void | Promise<void>
  onDelivery?: (delivery: S2sDeliveryEvent) => void
  onClose?: (event: { manual: boolean; code: number; reason: string }) => void
  onError?: (error: Error) => void
}

/** One in-flight send awaiting its `accepted` (or `error`) frame. */
type PendingRequest = {
  resolve: (result: S2sAcceptedMessage) => void
  reject: (error: Error) => void
}

/** The realtime client connection. */
export class S2sConnection {
  private readonly socket: WebSocket
  private readonly projectName: string
  private readonly rosterName: string
  private selfPeer: S2sPeer | null = null
  private peerMap = new Map<string, S2sPeer>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly events: S2sConnectionEvents
  private readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private readonly closed: Promise<void>
  private resolveClosed!: () => void
  private manualClose = false
  private messageQueue: Promise<void> = Promise.resolve()

  private constructor(baseUrl: string, project: string, name: string, events: S2sConnectionEvents) {
    this.projectName = project
    this.rosterName = name
    this.events = events
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
    this.socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/connect`)
    this.socket.on('open', () => {
      this.sendFrame({
        type: 'hello',
        protocolVersion: S2S_PROTOCOL_VERSION,
        project: this.projectName,
        name: this.rosterName,
      })
    })
    this.socket.on('message', (data) => { this.handleFrame(JSON.parse(frameText(data)) as S2sServerFrame) })
    this.socket.on('error', (error) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.events.onError?.(failure)
      if (!this.selfPeer) this.rejectReady(failure)
    })
    this.socket.on('close', (code, reason) => {
      const failure = new Error(`S2S connection closed (${code}): ${reason.toString() || 'no reason'}`)
      if (!this.selfPeer) this.rejectReady(failure)
      for (const pending of this.pending.values()) pending.reject(failure)
      this.pending.clear()
      this.events.onClose?.({
        manual: this.manualClose,
        code,
        reason: reason.toString(),
      })
      this.resolveClosed()
    })
  }

  /**
   * Open a connection and await the claim handshake.
   * @param options - hub base URL, project, roster name, and event callbacks.
   * @returns the ready connection.
   * @throws when the hub rejects the claim or the socket fails before `claimed`.
   */
  static async connect(options: {
    baseUrl: string
    project: string
    name: string
    events?: S2sConnectionEvents
  }): Promise<S2sConnection> {
    const connection = new S2sConnection(
      options.baseUrl,
      options.project,
      options.name,
      options.events ?? {},
    )
    await connection.ready
    return connection
  }

  /** The connected project. */
  get project(): string {
    return this.projectName
  }

  /** The claimed roster name. */
  get name(): string {
    return this.rosterName
  }

  /** The claimed presence identity (valid once ready). */
  get self(): S2sPeer {
    if (!this.selfPeer) throw new Error('S2S connection is not ready')
    return { ...this.selfPeer }
  }

  /**
   * The current roster, sorted by name.
   * @returns the live peers.
   */
  peers(): S2sPeer[] {
    return Array.from(this.peerMap.values(), peer => ({ ...peer })).sort(
      (left, right) => left.name.localeCompare(right.name),
    )
  }

  /**
   * Send one message and await its acceptance.
   * @param options - target, text, attachments, replyTo, and an optional
   * caller-chosen messageId (idempotency key).
   * @returns the accepted message and recipients.
   */
  send(options: {
    target: S2sMessageRequestTarget
    text: string
    attachments?: EncodedAttachment[]
    replyTo?: string
    messageId?: string
  }): Promise<S2sAcceptedMessage> {
    const requestId = crypto.randomUUID()
    const messageId = options.messageId ?? crypto.randomUUID()
    return new Promise<S2sAcceptedMessage>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      try {
        this.sendFrame({
          type: 'message',
          requestId,
          messageId,
          target: options.target,
          payload: encodeTextPayload(options.text),
          attachments: options.attachments ?? [],
          ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
        })
      } catch (error) {
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Close the connection (no reconnect is attempted by the connection itself). */
  close(): Promise<void> {
    this.manualClose = true
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    this.socket.close(1000, 'client disconnect')
    return this.closed
  }

  /** Dispatch one server frame. */
  private handleFrame(frame: S2sServerFrame): void {
    switch (frame.type) {
      case 'claimed':
        this.selfPeer = frame.self
        this.peerMap = new Map(frame.peers.map(peer => [peer.presenceId, peer]))
        this.resolveReady()
        return
      case 'presence_joined':
        this.peerMap.set(frame.peer.presenceId, frame.peer)
        this.events.onPresenceJoined?.({ ...frame.peer })
        return
      case 'presence_left':
        this.peerMap.delete(frame.peer.presenceId)
        this.events.onPresenceLeft?.({ ...frame.peer }, frame.reason)
        return
      case 'message':
        // Deliver inbound messages serially in hub-assigned sequence order:
        // the next message's handler runs only after this one settles.
        this.messageQueue = this.messageQueue.then(() => this.deliverMessage(frame.message))
        return
      case 'delivery':
        this.events.onDelivery?.(frame.status === 'failed'
          ? { messageId: frame.messageId, to: frame.to, status: frame.status, error: frame.error }
          : { messageId: frame.messageId, to: frame.to, status: frame.status })
        return
      case 'accepted': {
        const pending = this.pending.get(frame.requestId)
        if (!pending) return
        this.pending.delete(frame.requestId)
        pending.resolve({ message: frame.message, recipients: frame.recipients })
        return
      }
      case 'error': {
        const failure = connectionError(frame.code, frame.message)
        if (frame.requestId) {
          const pending = this.pending.get(frame.requestId)
          if (pending) {
            this.pending.delete(frame.requestId)
            pending.reject(failure)
            return
          }
        }
        if (!this.selfPeer) this.rejectReady(failure)
        else this.events.onError?.(failure)
        return
      }
    }
  }

  /** Deliver one inbound message; acknowledge success or report failure. */
  private async deliverMessage(message: S2sRealtimeMessage): Promise<void> {
    try {
      await this.events.onMessage?.(message)
      this.sendFrame({ type: 'delivered', messageId: message.messageId })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      try {
        this.sendFrame({
          type: 'delivery_failed',
          messageId: message.messageId,
          error: deliveryFailureMessage(failure),
        })
      } catch (sendError) {
        this.events.onError?.(sendError instanceof Error ? sendError : new Error(String(sendError)))
      }
      this.events.onError?.(failure)
    }
  }

  /** Send one frame on an open socket. */
  private sendFrame(frame: S2sClientFrame): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('S2S WebSocket is not open')
    this.socket.send(JSON.stringify(frame))
  }
}
