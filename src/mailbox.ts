/**
 * The dormant-session mailbox: one durable JSON file per queued message
 * under `<mailboxDir>/<sessionId>/<msgId>.json`. Files survive restarts and
 * are removed as they drain, so an empty mailbox is an empty directory.
 * @module dsh-s2s/mailbox
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { S2sError } from './error.ts'

/** One queued message for a dormant session. */
export interface MailboxEntry {
  /** Idempotency / dedup key; also the file name stem. */
  readonly msgId: string
  /** The sending party label (roster name or tool caller). */
  readonly from: string
  /** The message text. */
  readonly text: string
  /** Optional project message reference this entry replies to. */
  readonly replyTo?: string
  /** Enqueue epoch ms. */
  readonly createdAt: number
}

/** Session ids become path segments; anything else is rejected. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * The durable mailbox. Writes are atomic (tmp + rename); unreadable entries
 * are skipped with a warning instead of poisoning the drain.
 */
export class S2sMailbox {
  private readonly rootDir: string

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? join(homedir(), '.dsh', 's2s', 'mailboxes')
  }

  /** Queue one entry; same-session duplicate msgIds overwrite (idempotent). */
  async enqueue(sessionId: string, entry: MailboxEntry): Promise<void> {
    const dir = this.dirFor(sessionId)
    await mkdir(dir, { recursive: true })
    // Name files with a zero-padded epoch prefix so a lexicographic
    // readdir is already chronological, independent of msgId contents.
    const file = join(dir, `${String(entry.createdAt).padStart(15, '0')}-${entry.msgId}.json`)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(entry), 'utf8')
    await rename(tmp, file)
  }

  /** Take every entry (oldest first) and remove its file. */
  async drain(sessionId: string): Promise<MailboxEntry[]> {
    const dir = this.dirFor(sessionId)
    const names = await readdir(dir).catch(() => [] as string[])
    const entries: MailboxEntry[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const file = join(dir, name)
      try {
        entries.push(JSON.parse(await readFile(file, 'utf8')) as MailboxEntry)
        await rm(file, { force: true })
      } catch (error) {
        // A corrupt or vanished entry must not block the rest of the drain,
        // and it must not linger: remove it so count() stays truthful.
        await rm(file, { force: true }).catch(() => undefined)
        console.warn(`s2s mailbox: removed unreadable entry ${name}: ${String(error)}`)
      }
    }
    return entries
  }

  /** Queued entry count for one session. */
  async count(sessionId: string): Promise<number> {
    const dir = this.dirFor(sessionId)
    const names = await readdir(dir).catch(() => [] as string[])
    return names.filter(name => name.endsWith('.json')).length
  }

  private dirFor(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new S2sError(`s2s mailbox: unsafe session id ${JSON.stringify(sessionId)}`, 'S2S_INVALID_MESSAGE')
    }
    return join(this.rootDir, sessionId)
  }
}

/** Ensure a mailbox directory exists (used by spec setup to pre-seed). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/** Entry file mtime, when present (used by drain ordering guarantees). */
export async function fileMtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}
