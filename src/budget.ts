/**
 * Sender-side anti-loop budget for the s2s seam: a per-message hop cap, a
 * per-(from,to) sliding-window rate limit, and (opt-in) an intelligent
 * semantic layer that reads the recent exchange and breaks the loop when it
 * judges the interaction meaningless token-burning. Enforcement is opt-in —
 * the entry plugin mounts it only when a `budget` config block is present —
 * and hard breaks throw so callers fail loud instead of silently dropping.
 * @module dsh-s2s/budget
 */

import { S2sError } from './error.ts'

/** Semantic-layer knobs; absent fields fall back to the defaults below. */
export interface SemanticConfig {
  /** Master switch for the semantic layer. */
  readonly enabled?: boolean
  /** Optional judge model override; default = the sender session's current model. */
  readonly judgeModel?: string
  /** How many of the most recent exchanges the judge reads (default 6). */
  readonly window?: number
  /** Exchanges at or under this count are never judged (default 6); only above it does the semantic layer engage. */
  readonly graceExchanges?: number
  /** Minimum confidence to break on a 'meaningless' verdict (default 0.75). */
  readonly confidence?: number
  /** Verdict cache TTL per (from,to) (default 120000 ms). */
  readonly cacheMs?: number
  /** hard = throw (fail loud); soft = return a warn result the caller surfaces. */
  readonly break?: 'hard' | 'soft'
}

/** Fully-resolved semantic config (all defaults applied) — the runtime shape. */
export interface ResolvedSemantic {
  readonly enabled: boolean
  readonly judgeModel?: string
  readonly window: number
  readonly graceExchanges: number
  readonly confidence: number
  readonly cacheMs: number
  readonly break: 'hard' | 'soft'
}

/** Budget knobs; absent fields fall back to the defaults below. */
export interface BudgetConfig {
  /** Maximum relay hops a message may carry (default 6). */
  readonly maxHops?: number
  /** Maximum sends per (from,to) pair per sliding minute (default 10). */
  readonly ratePerMinute?: number
  /** Optional semantic layer; engages only when semantic.enabled and a judge is injected. */
  readonly semantic?: SemanticConfig
}

/** Defaults applied to absent budget fields. */
export const BUDGET_DEFAULTS = { maxHops: 6, ratePerMinute: 10 } as const

/** Defaults applied to absent semantic fields. */
export const SEMANTIC_DEFAULTS = { window: 6, graceExchanges: 6, confidence: 0.75, cacheMs: 120_000, break: 'hard' } as const

const WINDOW_MS = 60_000

/** One exchange line in a (from,to) thread, as the judge reads it. */
export interface S2sThreadEntry {
  readonly from: string
  readonly text: string
  readonly at: number
}

/** The judge's verdict on the recent exchange. */
export interface S2sVerdict {
  readonly meaningful: boolean
  readonly confidence: number
  readonly reason: string
}

/** Context handed to the semantic judge. */
export interface S2sJudgeRequest {
  readonly from: string
  readonly to: string
  readonly thread: readonly S2sThreadEntry[]
  /** Sender session's current model selection (provider/model), when known. */
  readonly model?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/** The semantic judge port: injected at construction (tests inject a fake). */
export type S2sJudge = (req: S2sJudgeRequest) => Promise<S2sVerdict>

/** Result of one budget check. */
export type S2sCheckResult =
  | { readonly verdict: 'proceed' }
  | { readonly verdict: 'warn'; readonly reason: string }

interface CachedVerdict {
  readonly at: number
  readonly verdict: S2sVerdict
}

/**
 * The budget guard. Deterministic caps are stateless across restarts; the
 * semantic verdict cache is in-memory and short-TTL (a loop rebuilt after a
 * restart is still bounded per minute by fresh windows and re-judged).
 */
export class S2sBudget {
  private readonly maxHops: number
  private readonly ratePerMinute: number
  private readonly semantic: ResolvedSemantic | undefined
  private readonly judge: S2sJudge | undefined
  private readonly windows = new Map<string, number[]>()
  private readonly cache = new Map<string, CachedVerdict>()

  constructor(config: BudgetConfig = {}, judge?: S2sJudge) {
    this.maxHops = config.maxHops ?? BUDGET_DEFAULTS.maxHops
    this.ratePerMinute = config.ratePerMinute ?? BUDGET_DEFAULTS.ratePerMinute
    this.semantic = config.semantic?.enabled
      ? {
          enabled: true,
          ...(config.semantic.judgeModel === undefined ? {} : { judgeModel: config.semantic.judgeModel }),
          window: config.semantic.window ?? SEMANTIC_DEFAULTS.window,
          graceExchanges: config.semantic.graceExchanges ?? SEMANTIC_DEFAULTS.graceExchanges,
          confidence: config.semantic.confidence ?? SEMANTIC_DEFAULTS.confidence,
          cacheMs: config.semantic.cacheMs ?? SEMANTIC_DEFAULTS.cacheMs,
          break: config.semantic.break ?? SEMANTIC_DEFAULTS.break,
        }
      : undefined
    this.judge = judge
  }

  /**
   * Enforce the hop cap, the per-pair rate, and (when configured) the semantic
   * layer. Hard break throws S2S_BUDGET_EXCEEDED / S2S_BUDGET_RATE /
   * S2S_BUDGET_MEANINGLESS; soft break returns a warn result. A judge failure
   * degrades to the counting caps (never a false break).
   * @param from - the sending party id.
   * @param to - the receiving party id.
   * @param hop - relay depth the message already carries (direct sends pass 0).
   * @param thread - recent (from,to) exchange, oldest first.
   * @param model - the sender session's current model selection (for the judge).
   */
  async check(
    from: string,
    to: string,
    hop: number,
    thread: readonly S2sThreadEntry[] = [],
    model?: S2sJudgeRequest['model'],
  ): Promise<S2sCheckResult> {
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

    const semantic = this.semantic
    const judge = this.judge
    if (semantic === undefined || judge === undefined) return { verdict: 'proceed' }
    // Grace window: at or under graceExchanges the sender is left completely free.
    if (thread.length <= semantic.graceExchanges) return { verdict: 'proceed' }

    const cached = this.cache.get(key)
    if (cached !== undefined && now - cached.at < semantic.cacheMs) {
      return this.resolve(cached.verdict, semantic)
    }
    let verdict: S2sVerdict
    try {
      verdict = await judge({
        from,
        to,
        thread: thread.slice(-semantic.window),
        ...(model === undefined ? {} : { model }),
      })
    } catch {
      // Judge unavailable / failed: degrade to the counting caps only.
      return { verdict: 'proceed' }
    }
    this.cache.set(key, { at: now, verdict })
    return this.resolve(verdict, semantic)
  }

  private resolve(verdict: S2sVerdict, semantic: SemanticConfig): S2sCheckResult {
    if (verdict.meaningful || verdict.confidence < (semantic.confidence ?? SEMANTIC_DEFAULTS.confidence)) {
      return { verdict: 'proceed' }
    }
    if (semantic.break === 'soft') return { verdict: 'warn', reason: verdict.reason }
    throw new S2sError(
      `s2s budget: judge judged the exchange meaningless: ${verdict.reason || 'no reason given'}`,
      'S2S_BUDGET_MEANINGLESS',
    )
  }
}
