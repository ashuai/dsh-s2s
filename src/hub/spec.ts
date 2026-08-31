/**
 * Durable s2s hub domain (protocol version 3): project metadata, per-project
 * sequence counters, the immutable message history, and the msgId
 * idempotency index. Presence, delivery, and roster state are in-memory
 * only — messages are the sole durable record. One domain over the routed
 * backend; the domain's single write chain serializes every mutation, and
 * the message store adds its own chain so an append (sequence allocation +
 * inserts) never interleaves with another append.
 * @module @dpskh/a2a/hub/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Composite table key separator; none of the parts may contain it. */
export const KEY_SEP = '/'

/** One stored project. */
export const s2sProjectRecord = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  createdByCwd: z.string().optional(),
  createdAt: z.number(),
})

/** One per-project sequence counter (seeded at project creation). */
export const s2sSequenceRecord = z.object({
  next: z.number(),
})

/** One stored attachment: a name plus its encoded content bytes. */
export const s2sAttachmentRecord = z.object({
  name: z.string(),
  payload: z.object({
    encoding: z.enum(['base64', 'gzip+base64']),
    data: z.string(),
    uncompressedBytes: z.number(),
  }),
})

/**
 * One stored message. `msgId` rides the idempotency index; the composite
 * key is `project/sequence`. `contentBytes` is the decoded text plus
 * attachment byte total, verified at read.
 */
export const s2sMessageRecord = z.object({
  msgId: z.string(),
  senderName: z.string(),
  senderPresenceId: z.string(),
  target: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('agent'),
      name: z.string(),
      presenceId: z.string().optional(),
    }),
    z.object({ type: z.literal('project') }),
  ]),
  encoding: z.enum(['identity', 'gzip+base64']),
  data: z.string(),
  uncompressedBytes: z.number(),
  attachments: z.array(s2sAttachmentRecord).default([]),
  contentBytes: z.number(),
  createdAt: z.number(),
  replyToSequence: z.number().optional(),
})

/** One msgId → (project, sequence) idempotency index row. */
export const s2sMessageIdRecord = z.object({
  project: z.string(),
  sequence: z.number(),
})

/** Durable hub state, one domain over the routed backend. */
export const s2sHubDomainSpec = defineDomain({
  name: 's2s',
  version: 3,
  tables: {
    projects: domainTable<string, z.infer<typeof s2sProjectRecord>>(s2sProjectRecord),
    sequences: domainTable<string, z.infer<typeof s2sSequenceRecord>>(s2sSequenceRecord),
    messages: domainTable<string, z.infer<typeof s2sMessageRecord>>(s2sMessageRecord),
    message_ids: domainTable<string, z.infer<typeof s2sMessageIdRecord>>(s2sMessageIdRecord),
  },
})

/** Join parts into one composite table key.
 * @param parts - key parts, none containing the separator.
 * @returns the joined key.
 */
export function compositeKey(parts: readonly string[]): string {
  return parts.join(KEY_SEP)
}
