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

  // Session logs are append-only: every append is its own zstd frame, so a real
  // log holds thousands of frames. A single-stream decoder silently returns
  // only the first frame, which made every on-disk title unreadable.
  it('reads the title from the LAST frame of a multi-frame log', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-z-'))
    dirs.push(root)
    const sdir = join(root, 'ws-a', 'session-z4')
    await mkdir(sdir, { recursive: true })
    const frames = ['first', 'second', 'third'].map((name, i) =>
      zlib.zstdCompressSync(Buffer.from(`{"type":"session/title","data":{"title":"${name}-${i}"}}\n`, 'utf8')))
    await writeFile(join(sdir, 'session.jsonl.zstd'), Buffer.concat(frames))
    const d = await mount(root)
    const list = await d.list()
    expect(list.length).toBe(1)
    expect(list[0]!.title).toBe('third-2')
    await d.ctx.fiber.dispose()
  })

  it('reads a title from a log of many frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-z-'))
    dirs.push(root)
    const sdir = join(root, 'ws-a', 'session-z5')
    await mkdir(sdir, { recursive: true })
    const frames: Buffer[] = []
    for (let i = 0; i < 512; i++) {
      frames.push(zlib.zstdCompressSync(Buffer.from(`{"type":"session/note","data":{"n":${i}}}\n`, 'utf8')))
    }
    frames.push(zlib.zstdCompressSync(Buffer.from('{"type":"session/title","data":{"title":"末帧标题"}}\n', 'utf8')))
    await writeFile(join(sdir, 'session.jsonl.zstd'), Buffer.concat(frames))
    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBe('末帧标题')
    await d.ctx.fiber.dispose()
  })

  it('recovers the title when the final frame is torn off', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-z-'))
    dirs.push(root)
    const sdir = join(root, 'ws-a', 'session-z6')
    await mkdir(sdir, { recursive: true })
    const complete = zlib.zstdCompressSync(Buffer.from('{"type":"session/title","data":{"title":"完整帧"}}\n', 'utf8'))
    const torn = zlib.zstdCompressSync(Buffer.from('{"type":"session/title","data":{"title":"截断帧"}}\n', 'utf8')).subarray(0, 12)
    await writeFile(join(sdir, 'session.jsonl.zstd'), Buffer.concat([complete, torn]))
    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBe('完整帧')
    await d.ctx.fiber.dispose()
  })
})
