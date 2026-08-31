import { describe, expect, it } from 'vitest'
import { S2sBudget } from '../src/budget.ts'
import { S2sError } from '../src/error.ts'

function codeOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    return (error as S2sError).code
  }
  return 'no-throw'
}

describe('s2s budget', () => {
  it('rejects sends at or beyond the hop cap', () => {
    const budget = new S2sBudget({ maxHops: 2 })
    expect(codeOf(() => budget.check('a', 'b', 2))).toBe('S2S_BUDGET_EXCEEDED')
    expect(codeOf(() => budget.check('a', 'b', 1))).toBe('no-throw')
  })

  it('enforces the per-pair sliding-window rate and keeps pairs independent', () => {
    const budget = new S2sBudget({ ratePerMinute: 2 })
    budget.check('a', 'b', 0)
    budget.check('a', 'b', 0)
    expect(codeOf(() => budget.check('a', 'b', 0))).toBe('S2S_BUDGET_RATE')
    expect(codeOf(() => budget.check('a', 'c', 0))).toBe('no-throw')
  })

  it('applies the documented defaults (maxHops 6, rate 10/min)', () => {
    const budget = new S2sBudget()
    expect(codeOf(() => budget.check('x', 'hop', 5))).toBe('no-throw')
    expect(codeOf(() => budget.check('x', 'hop', 6))).toBe('S2S_BUDGET_EXCEEDED')
    for (let i = 0; i < 10; i += 1) budget.check('x', 'y', 0)
    expect(codeOf(() => budget.check('x', 'y', 0))).toBe('S2S_BUDGET_RATE')
  })

  it('does not consume rate window when the hop cap throws', () => {
    const budget = new S2sBudget({ maxHops: 1, ratePerMinute: 1 })
    expect(codeOf(() => budget.check('a', 'b', 9))).toBe('S2S_BUDGET_EXCEEDED')
    expect(codeOf(() => budget.check('a', 'b', 0))).toBe('no-throw')
  })
})
