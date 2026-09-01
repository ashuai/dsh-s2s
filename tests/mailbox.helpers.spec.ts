import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDir, fileMtime } from '../src/mailbox.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

describe('s2s mailbox helpers', () => {
  it('ensureDir and fileMtime (existing + missing)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2s-mbh-'))
    dirs.push(dir)
    await ensureDir(dir)
    await ensureDir(join(dir, 'nested', 'deep'))
    await writeFile(join(dir, 'a.json'), '{}', 'utf8')
    expect(await fileMtime(join(dir, 'a.json'))).toBeGreaterThan(0)
    expect(await fileMtime(join(dir, 'nonexistent'))).toBeUndefined()
  })
})