/**
 * Strict Session projection of the s2s schedule domain: folds `s2s/schedule-change`
 * events into a session-scoped view of the jobs, mirroring `dsh-schedule` projection.
 * @module dsh-s2s/schedule-project
 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

import type { ScheduleJob } from './schedule.ts'

/** One durable s2s schedule change appended to a session log. */
export type S2sScheduleChange =
  | { version: 1; operation: 'create'; job: ScheduleJob }
  | { version: 1; operation: 'cancel'; id: string }

/** Persisted projection state: inherited cut + active jobs + seen ids. */
export interface S2sScheduleProjectionState {
  readonly inheritedEventCount: number
  readonly active: readonly ScheduleJob[]
  readonly seenIds: readonly string[]
}

/** Decode a strict version-1 `s2s/schedule-change` payload. */
export function decodeS2sScheduleChange(raw: unknown): S2sScheduleChange {
  if (raw === null || typeof raw !== 'object') throw new Error('s2s/schedule-change payload must be an object')
  const r = raw as Record<string, unknown>
  if (r['version'] !== 1) throw new Error('s2s/schedule-change version must be 1')
  const op = r['operation']
  if (op === 'create') {
    if (r['job'] === null || typeof r['job'] !== 'object') throw new Error('s2s create must contain a job')
    return { version: 1, operation: 'create', job: r['job'] as unknown as ScheduleJob }
  }
  if (op === 'cancel') {
    if (typeof r['id'] !== 'string') throw new Error('s2s cancel must contain an id')
    return { version: 1, operation: 'cancel', id: r['id'] }
  }
  throw new Error('s2s/schedule-change operation must be create or cancel')
}

/** Fold one decoded change onto the state. */
export function applyS2sScheduleChanges(state: S2sScheduleProjectionState, changes: readonly S2sScheduleChange[]): S2sScheduleProjectionState {
  let active = [...state.active]
  const seen = [...state.seenIds]
  for (const change of changes) {
    if (change.operation === 'create') {
      seen.push(change.job.id)
      const existing = active.findIndex((job) => job.id === change.job.id)
      if (existing >= 0) active[existing] = change.job
      else active.push(change.job)
    } else {
      active = active.filter((job) => job.id !== change.id)
      seen.push(change.id)
    }
  }
  return { inheritedEventCount: state.inheritedEventCount, active, seenIds: seen }
}

/** Replay a raw event suffix onto an initial state (inherited cut aware). */
export function foldS2sScheduleEvents(state: S2sScheduleProjectionState, events: ReadonlyArray<{ seq: number; type: string; data: unknown }>): S2sScheduleProjectionState {
  let s = state
  for (const event of events) {
    if (event.seq < state.inheritedEventCount || event.type !== 's2s/schedule-change') continue
    s = applyS2sScheduleChanges(s, [decodeS2sScheduleChange(event.data)])
  }
  return s
}

/** Projection definition sharing the s2s schedule change authority. */
export const s2sScheduleProjectionDefinition = {
  key: 's2s-schedule',
  init: (_header: unknown, inheritedEventCount: number) => ({ inheritedEventCount, active: [], seenIds: [] }),
  apply: (state: S2sScheduleProjectionState, event: { seq: number; type: string; data: unknown }) => {
    if (event.seq < state.inheritedEventCount || event.type !== 's2s/schedule-change') return state
    return applyS2sScheduleChanges(state, [decodeS2sScheduleChange(event.data)])
  },
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    's2s-schedule': S2sScheduleProjectionState
  }
}
