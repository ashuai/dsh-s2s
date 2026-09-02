import { describe, expect, it } from 'vitest'
import { applyS2sScheduleChanges, decodeS2sScheduleChange, foldS2sScheduleEvents } from '../src/schedule-project.ts'

describe('s2s schedule projection fold', () => {
  const state = { inheritedEventCount: 0, active: [], seenIds: [] }
  it('create then cancel folds active jobs', () => {
    const job = { id: 'j1', targetSessionId: 's1', text: 'x', everySeconds: 600, nextAt: 1, enabled: true, createdAt: 1 }
    let s = applyS2sScheduleChanges(state, [{ version: 1, operation: 'create', job }])
    expect(s.active).toHaveLength(1)
    expect(s.seenIds).toEqual(['j1'])
    s = applyS2sScheduleChanges(s, [{ version: 1, operation: 'cancel', id: 'j1' }])
    expect(s.active).toHaveLength(0)
  })
  it('upsert by id replaces and dedups seen', () => {
    const job = { id: 'j1', targetSessionId: 's1', text: 'a', everySeconds: 600, nextAt: 1, enabled: true, createdAt: 1 }
    const job2 = { ...job, text: 'b' }
    let s = applyS2sScheduleChanges(state, [{ version: 1, operation: 'create', job }])
    s = applyS2sScheduleChanges(s, [{ version: 1, operation: 'create', job: job2 }])
    expect(s.active).toHaveLength(1)
    expect(s.active[0]!.text).toBe('b')
  })
  it('decode rejects bad payloads', () => {
    expect(() => decodeS2sScheduleChange({ version: 2 })).toThrow(/version/)
    expect(() => decodeS2sScheduleChange({ version: 1, operation: 'x' })).toThrow(/operation/)
  })
  it('fold respects inherited cut and type', () => {
    const job = { id: 'j1', targetSessionId: 's1', text: 'x', everySeconds: 600, nextAt: 1, enabled: true, createdAt: 1 }
    const st = { inheritedEventCount: 5, active: [], seenIds: [] }
    const out = foldS2sScheduleEvents(st, [
      { seq: 4, type: 's2s/schedule-change', data: { version: 1, operation: 'create', job } },
      { seq: 6, type: 's2s/schedule-change', data: { version: 1, operation: 'create', job } },
      { seq: 7, type: 'other', data: {} },
    ])
    expect(out.active).toHaveLength(1)
  })
})