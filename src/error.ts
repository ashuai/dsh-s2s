/**
 * Domain errors for the s2s seam. Failures carry a stable machine-routable
 * code; route on `code`, never by parsing `message`.
 * @module dsh-s2s/error
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'

export type S2sErrorCode =
  | 'S2S_UNKNOWN_SESSION'
  | 'S2S_AMBIGUOUS_NAME'
  | 'S2S_DORMANT'
  | 'S2S_LIFECYCLE'
  | 'S2S_BUDGET_EXCEEDED'
  | 'S2S_BUDGET_RATE'
  | 'S2S_INVALID_MESSAGE'

export class S2sError extends HarnessError {
  override readonly code: S2sErrorCode
  constructor(message: string, code: S2sErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

