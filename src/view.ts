/**
 * Connection-graph projection of the mesh: the wire view the host gateway
 * serves to the web S2S page. Pure function over {@link S2sPeer} —
 * cordis-free so the browser half can type-share it without loading the
 * host plugin. Presence is binary: a peer is either live or gone.
 * @module @dpskh/a2a/view
 */

import type { S2sPeer } from './hub/types.ts'

export { AGENT_NAME_RE, PROJECT_NAME_RE } from './hub/message-ref.ts'

/**
 * One presence's conversation activity as seen from the local mesh:
 * `idle` (no recent exchange), `conversing` (a recent message exchange is
 * still alive), or `working` (processing a received conversation — for a
 * remote peer, inferred from a delivered send until it answers).
 */
export type S2sPeerActivity = 'idle' | 'conversing' | 'working'

/** Wire view of one mesh peer for the connection graph. */
export interface S2sPeerView {
  /** Graph node id: the presence id (unique per live connection). */
  readonly id: string
  /** Roster name of the peer. */
  readonly name: string
  /** Transport badge: mesh peers always ride the hub. */
  readonly transport: 'hub'
  /** Display target: the hub project the peer belongs to. */
  readonly target: string
  /** Derived liveness: live peers are always `online` (presence = socket). */
  readonly status: 'online'
  /** Conversation activity driving the graph animation. */
  readonly activity: S2sPeerActivity
}

/**
 * Project one peer to its connection-graph view.
 * @param peer - the present peer.
 * @param project - the peer's project.
 * @param activity - the peer's conversation activity from the local view.
 * @returns the wire view.
 */
export function peerView(peer: S2sPeer, project: string, activity: S2sPeerActivity): S2sPeerView {
  return {
    id: peer.presenceId,
    name: peer.name,
    transport: 'hub',
    target: project,
    status: 'online',
    activity,
  }
}
