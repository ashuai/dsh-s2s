/**
 * Sender-side anti-loop budget for the s2s seam: a per-message hop cap and a
 * per-(from,to) sliding-window rate limit. Enforcement is opt-in — the entry
 * plugin mounts it only when a `budget` config block is present, and every
 * check is a plain throw so callers fail loud instead of silently dropping.
 * @module dsh-s2s/budget
 */

import { S2sError } from './error.ts'

/** Budget knobs; absent fields fall back to the defaults below. */
export interface BudgetConfig {
  /** Maximum relay hops a message may carry (default 6). */
  readonly maxHops?: number
  /** Maximum sends per (from,to) pair per sliding minute (default 10). */
  readonly ratePerMinute?: number
}

/** Defaults applied to absent budget fields. */
export const BUDGET_DEFAULTS = { maxHops: 6, ratePerMinute: 10 } as const

const WINDOW_MS = 60_000

/**
 * The budget guard. Stateless across restarts by design: a loop rebuilt
 * after a restart is still bounded per minute by fresh windows.
 */
export class S2sBudget {
  private readonly maxHops: number
  private readonly ratePerMinute: number
  private readonly windows = new Map<string, number[]>()

  constructor(config: BudgetConfig = {}) {
    this.maxHops = config.maxHops ?? BUDGET_DEFAULTS.maxHops
    this.ratePerMinute = config.ratePerMinute ?? BUDGET_DEFAULTS.ratePerMinute
  }

  /**
   * Enforce the hop cap and the per-pair rate for one send.
   * @param from - the sending party id (agent id or lifecycle tag).
   * @param to - the receiving party id (roster name or `project`).
   * @param hop - the relay depth the message already carries; direct sends
   *   pass 0, relays pass the incoming hop plus one.
   * @throws S2sError with `S2S_BUDGET_EXCEEDED` or `S2S_BUDGET_RATE`.
   */
  check(from: string, to: string, hop: number): void {
    if (hop >= this.maxHops) {
      throw new S2sError(`s2s budget: hop ${hop} exceeds maxHops ${this.maxHops} (from=${from} to=${to})`, 'S2S_BUDGET_EXCEEDED')
    }
    const key = `${from}\u0000${to}`
    const now = Date.now()
    const window = (this.windows.get(key) ?? []).filter(at => now - at < WINDOW_MS)
    if (window.length >= this.ratePerMinute) {
      throw new S2sError(`s2s budget: rate limit ${this.ratePerMinute}/min reached for ${from} -> ${to}`, 'S2S_BUDGET_RATE')
    }
    window.push(now)
    this.windows.set(key, window)
  }
}
