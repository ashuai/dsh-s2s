import { describe, expect, it, vi } from 'vitest'
import { S2sBudget, type S2sThreadEntry, type S2sVerdict } from '../src/budget.ts'
import { S2sError } from '../src/error.ts'

async function codeOf(run: () => Promise<void>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as S2sError).code
  }
  return 'no-throw'
}

function thread(count: number, from = 'a', text = 'hi'): S2sThreadEntry[] {
  return Array.from({ length: count }, (_, i) => ({ from, text, at: 1000 + i }))
}

const meaningful: S2sVerdict = { meaningful: true, confidence: 0.9, reason: 'progress' }
const meaningless: S2sVerdict = { meaningful: false, confidence: 0.9, reason: 'ping-pong' }

describe('s2s budget', () => {
  it('rejects sends at or beyond the hop cap', async () => {
    const budget = new S2sBudget({ maxHops: 2 })
    expect(await codeOf(async () => { await budget.check('a', 'b', 2) })).toBe('S2S_BUDGET_EXCEEDED')
    expect(await codeOf(async () => { await budget.check('a', 'b', 1) })).toBe('no-throw')
  })

  it('enforces the per-pair sliding-window rate and keeps pairs independent', async () => {
    const budget = new S2sBudget({ ratePerMinute: 2 })
    await budget.check('a', 'b', 0)
    await budget.check('a', 'b', 0)
    expect(await codeOf(async () => { await budget.check('a', 'b', 0) })).toBe('S2S_BUDGET_RATE')
    expect(await codeOf(async () => { await budget.check('a', 'c', 0) })).toBe('no-throw')
  })

  it('applies the documented defaults (maxHops 6, rate 10/min)', async () => {
    const budget = new S2sBudget()
    expect(await codeOf(async () => { await budget.check('x', 'hop', 5) })).toBe('no-throw')
    expect(await codeOf(async () => { await budget.check('x', 'hop', 6) })).toBe('S2S_BUDGET_EXCEEDED')
    for (let i = 0; i < 10; i += 1) await budget.check('x', 'y', 0)
    expect(await codeOf(async () => { await budget.check('x', 'y', 0) })).toBe('S2S_BUDGET_RATE')
  })

  it('does not consume rate window when the hop cap throws', async () => {
    const budget = new S2sBudget({ maxHops: 1, ratePerMinute: 1 })
    expect(await codeOf(async () => { await budget.check('a', 'b', 9) })).toBe('S2S_BUDGET_EXCEEDED')
    expect(await codeOf(async () => { await budget.check('a', 'b', 0) })).toBe('no-throw')
  })

  describe('semantic layer', () => {
    it('never judges within the grace window (<= graceExchanges)', async () => {
      const judge = vi.fn(async () => meaningless)
      const budget = new S2sBudget({ semantic: { enabled: true } }, judge)
      expect(await budget.check('a', 'b', 0, thread(6))).toEqual({ verdict: 'proceed' })
      expect(judge).not.toHaveBeenCalled()
    })

    it('judges only once the exchange exceeds the grace window; hard-breaks on meaningless', async () => {
      const judge = vi.fn(async () => meaningless)
      const budget = new S2sBudget({ semantic: { enabled: true } }, judge)
      await budget.check('a', 'b', 0, thread(6))
      expect(await codeOf(async () => { await budget.check('a', 'b', 0, thread(7)) })).toBe('S2S_BUDGET_MEANINGLESS')
      expect(judge).toHaveBeenCalledTimes(1)
    })

    it('soft break returns a warn result instead of throwing', async () => {
      const judge = vi.fn(async () => meaningless)
      const budget = new S2sBudget({ semantic: { enabled: true, break: 'soft' } }, judge)
      const res = await budget.check('a', 'b', 0, thread(7))
      expect(res).toEqual({ verdict: 'warn', reason: 'ping-pong' })
      expect(judge).toHaveBeenCalledTimes(1)
    })

    it('does not break on a meaningful verdict', async () => {
      const judge = vi.fn(async () => meaningful)
      const budget = new S2sBudget({ semantic: { enabled: true } }, judge)
      expect(await budget.check('a', 'b', 0, thread(7))).toEqual({ verdict: 'proceed' })
      expect(judge).toHaveBeenCalledTimes(1)
    })

    it('does not break below the confidence threshold', async () => {
      const judge = vi.fn(async () => ({ meaningful: false as const, confidence: 0.4, reason: 'unsure' }))
      const budget = new S2sBudget({ semantic: { enabled: true } }, judge)
      expect(await budget.check('a', 'b', 0, thread(7))).toEqual({ verdict: 'proceed' })
      expect(judge).toHaveBeenCalledTimes(1)
    })

    it('reuses a cached verdict within cacheMs (no re-judge)', async () => {
      const judge = vi.fn(async () => meaningless)
      const budget = new S2sBudget({ semantic: { enabled: true, cacheMs: 60000 } }, judge)
      await codeOf(async () => { await budget.check('a', 'b', 0, thread(7)) })
      await codeOf(async () => { await budget.check('a', 'b', 0, thread(7)) })
      expect(judge).toHaveBeenCalledTimes(1)
    })

    it('degrades to the counting caps when the judge throws', async () => {
      const judge = vi.fn(async () => { throw new Error('llm down') })
      const budget = new S2sBudget({ semantic: { enabled: true } }, judge)
      expect(await budget.check('a', 'b', 0, thread(7))).toEqual({ verdict: 'proceed' })
    })

    it('hands the judge only the recent window', async () => {
      const judge = vi.fn(async () => meaningful)
      const budget = new S2sBudget({ semantic: { enabled: true, window: 3 } }, judge)
      await budget.check('a', 'b', 0, thread(10))
      expect(judge).toHaveBeenCalledTimes(1)
      expect(judge.mock.calls[0][0]).toMatchObject({ from: 'a', to: 'b' })
      expect(judge.mock.calls[0][0].thread).toHaveLength(3)
    })

    it('shares the deterministic caps with the semantic layer', async () => {
      const judge = vi.fn(async () => meaningful)
      const budget = new S2sBudget({ semantic: { enabled: true }, maxHops: 1 }, judge)
      expect(await codeOf(async () => { await budget.check('a', 'b', 9, thread(20)) })).toBe('S2S_BUDGET_EXCEEDED')
    })
  })
})
