/**
 * Domain errors for the s2s seam. Wire and registry failures carry a stable
 * machine-routable code; route on `code`, never by parsing `message`.
 * @module @dpskh/a2a/error
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable machine-routable failure codes for the s2s seam. */
export type S2sErrorCode =
  | 'S2S_DUPLICATE_PEER'
  | 'S2S_DUPLICATE_PROVIDER'
  | 'S2S_CLIENT_CONFIGURED_MISSING'
  | 'S2S_CLIENT_CONFIGURED_UNAVAILABLE'
  | 'S2S_CLIENT_AMBIGUOUS'
  | 'S2S_CLIENT_UNAVAILABLE'
  | 'S2S_CLIENT_TRANSPORT'
  | 'S2S_CLIENT_CONNECT'
  | 'S2S_HTTP_INTERFACE'
  | 'S2S_HTTP_STATUS'
  | 'S2S_HTTP_TRANSPORT'
  | 'S2S_INVALID_AGENT_CARD'
  | 'S2S_INVALID_TASK'
  | 'S2S_INVALID_MESSAGE'
  | 'S2S_INVALID_PAYLOAD'
  | 'S2S_INVALID_JSONRPC'
  | 'S2S_BAD_REQUEST'
  | 'S2S_REGISTRY'
  | 'S2S_PROJECT_CONFLICT'
  | 'S2S_UNKNOWN_PROJECT'
  | 'S2S_NAME_IN_USE'
  | 'S2S_MESSAGE_ID_CONFLICT'
  | 'S2S_UNKNOWN_REPLY'
  | 'S2S_PAYLOAD_TOO_LARGE'
  | 'S2S_MESSAGE_REJECTED'
  | 'S2S_PROTOCOL_MISMATCH'
  | 'S2S_CLAIM_REJECTED'
  | 'S2S_INVALID_FRAME'
  | 'S2S_RECIPIENT_NOT_PRESENT'
  | 'S2S_BUDGET_EXCEEDED'
  | 'S2S_BUDGET_RATE'
  | 'S2S_LIFECYCLE'

/**
 * A wire-format or registry failure in the s2s seam.
 * @param message - human-readable failure description.
 * @param code - stable failure class for programmatic routing.
 * @param options - standard `Error` options (`cause` chaining).
 */
export class S2sError extends HarnessError {
  override readonly code: S2sErrorCode

  constructor(message: string, code: S2sErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
