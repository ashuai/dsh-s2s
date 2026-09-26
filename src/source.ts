/**
 * dsh-s2s message-source declaration.
 *
 * Session format v4 requires every injected message to carry a producer-owned
 * `source.kind`; the retired `{ kind: 'plugin', plugin: … }` wrapper is refused
 * at write admission (`format v4 message requires a producer-owned source
 * kind`) and aborts the whole turn. dsh-s2s therefore declares its own kind,
 * exactly as the shipped plugins do (`schedule`, `plan-mode`, `time-context`).
 * @module dsh-s2s/source
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-s2s': {
      kind: 'dsh-s2s'
    } & ContextFormed
  }
}

/** The producer-owned source carried by every message dsh-s2s injects. */
export const S2S_MESSAGE_SOURCE = { kind: 'dsh-s2s' } as const
