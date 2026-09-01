/**
 * dsh-llm MessageSourceMap augmentation: the s2s seam's source kinds.
 * Registered so createUserMessage accepts kind 's2s' (live broker delivery)
 * and 's2s-lifecycle' (dormant wake delivery).
 * @module dsh-s2s/types
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    s2s: { kind: 's2s'; msgId: string }
    's2s-lifecycle': { kind: 's2s-lifecycle'; msgId: string }
    's2s-schedule': { kind: 's2s-schedule'; jobId: string }
  }
}

export {}
