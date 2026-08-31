import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { S2sMailbox } from '../src/mailbox.ts'

const dirs: string[] = []
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 's2s-mbox-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('s2s mailbox', () => {
  it('drains chronologically and empties the queue', async () => {
    const box = new S2sMailbox(await tempRoot())
    await box.enqueue('sess-1', { msgId: 'm2', from: 'alice', text: 'second', createdAt: 2 })
    await box.enqueue('sess-1', { msgId: 'm1', from: 'alice', text: 'first', createdAt: 1 })
    expect(await box.count('sess-1')).toBe(2)
    const drained = await box.drain('sess-1')
    expect(drained.map(entry => entry.msgId)).toEqual(['m1', 'm2'])
    expect(await box.count('sess-1')).toBe(0)
  })

  it('rejects unsafe session ids loud', async () => {
    const box = new S2sMailbox(await tempRoot())
    await expect(box.enqueue('../evil', { msgId: 'm', from: 'a', text: 't', createdAt: 1 })).rejects.toThrow(/unsafe/)
    await expect(box.enqueue('a/b', { msgId: 'm', from: 'a', text: 't', createdAt: 1 })).rejects.toThrow(/unsafe/)
  })

  it('skips corrupt entries instead of poisoning the drain', async () => {
    const root = await tempRoot()
    const box = new S2sMailbox(root)
    await box.enqueue('sess-2', { msgId: 'ok', from: 'a', text: 't', createdAt: 5 })
    await writeFile(join(root, 'sess-2', '0000000000000009-bad.json'), 'not json', 'utf8')
    const drained = await box.drain('sess-2')
    expect(drained).toHaveLength(1)
    expect(drained[0]!.msgId).toBe('ok')
    expect(await box.count('sess-2')).toBe(0)
  })

  it('is idempotent per msgId (overwrite, not duplicate)', async () => {
    const box = new S2sMailbox(await tempRoot())
    const entry = { msgId: 'same', from: 'a', text: 't', createdAt: 7 }
    await box.enqueue('sess-3', entry)
    await box.enqueue('sess-3', entry)
    expect(await box.count('sess-3')).toBe(1)
  })
})
