import { describe, expect, it } from 'vitest'
import { parseVerdict } from '../src/judge.ts'

describe('s2s judge verdict parsing', () => {
  it('parses a plain JSON verdict', () => {
    expect(parseVerdict('{"meaningful":false,"confidence":0.8,"reason":"ping-pong"}')).toEqual({
      meaningful: false,
      confidence: 0.8,
      reason: 'ping-pong',
    })
  })

  it('tolerates code fences around the JSON', () => {
    expect(parseVerdict('\n\n\n{"meaningful":true,"confidence":0.9,"reason":"ok"}\n\n\n').meaningful).toBe(true)
  })

  it('extracts the first JSON object from prose', () => {
    const v = parseVerdict('Judge result: {"meaningful":false,"confidence":0.9,"reason":"repeat"} now stop')
    expect(v.meaningful).toBe(false)
    expect(v.reason).toBe('repeat')
  })

  it('throws when no JSON object is present', () => {
    expect(() => parseVerdict('no json here')).toThrow()
  })

  it('defaults to confidence 0 when absent or non-numeric', () => {
    expect(parseVerdict('{"meaningful":false,"reason":"x"}').confidence).toBe(0)
    expect(parseVerdict('{"meaningful":false,"confidence":"high","reason":"x"}').confidence).toBe(0)
  })
})
