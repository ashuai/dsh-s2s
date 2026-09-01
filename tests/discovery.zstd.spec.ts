import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import zlib from 'node:zlib'
import { S2sDiscoveryService } from '../src/discovery.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function mount(root: string) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined } as never)
  await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
  return ctx.get('s2sDiscovery') as S2sDiscoveryService
}

describe('s2s discovery zstd log path', () => {
  it('reads a title from a zstd-compressed session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-z-'))
    dirs.push(root)
    const sdir = join(root, 'ws-a', 'session-z1')
    await mkdir(sdir, { recursive: true })
    const payload = '{"type":"session","cwd":"/x"}\n{"type":"session/title","data":{"title":"部署"}}\n'
    await writeFile(join(sdir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(payload, 'utf8')))
    const d = await mount(root)
    const list = await d.list()
    expect(list.length).toBe(1)
    expect(list[0]!.sessionId).toBe('z1')
    expect(list[0]!.title).toBe('部署')
    await d.ctx.fiber.dispose()
  })
  it('falls back to plain jsonl when there is no zstd file', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-z-'))
    dirs.push(root)
    const sdir = join(root, 'ws-a', 'session-z2')
    await mkdir(sdir, { recursive: true })
    await writeFile(join(sdir, 'session.jsonl'), '{"type":"session/title","data":{"title":"回退"}}\n', 'utf8')
    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBe('回退')
    await d.ctx.fiber.dispose()
  })
  it('returns no title when the zstd log is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-z-'))
    dirs.push(root)
    const sdir = join(root, 'ws-a', 'session-z3')
    await mkdir(sdir, { recursive: true })
    await writeFile(join(sdir, 'session.jsonl.zstd'), 'not actually zstd', 'utf8')
    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBeUndefined()
    await d.ctx.fiber.dispose()
  })
})