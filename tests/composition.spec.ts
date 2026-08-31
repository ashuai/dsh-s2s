/**
 * Real composition: the entry plugin over the storage stack, with a hub
 * host, mesh clients, and the tool surface — one connected
 * workspace receiving an injected message end to end.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { apply as s2sApply, S2sHubHostService, decodeTextPayload } from '../src/index.ts'
import { S2sMeshService } from '../src/index.ts'

/** Mount the storage stack manually (the workspace-spec pattern). */
async function mountStorage(ctx: Context): Promise<void> {
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
}

async function harness(options: { mesh?: boolean } = {}) {
  const ctx = new Context()
  await mountStorage(ctx)
  await ctx.plugin(s2sApply, {
    hub: { host: '127.0.0.1', port: 0 },
    ...(options.mesh === false
      ? {}
      : {
        mesh: { hubUrl: 'http://127.0.0.1:0', project: 'mesh', agentId: 'agent-a' },
      }),
  })
  const hub = ctx.get('s2sHub')
  // The hub binds on an ephemeral port asynchronously; wait for it.
  if (hub !== undefined) {
    await vi.waitFor(() => {
      if (hub.port === undefined) throw new Error('hub not listening yet')
    }, { timeout: 2000 })
  }
  const port = hub?.port
  return { ctx, hub, port }
}

describe('s2s composition', () => {
  it('mounts the hub host and opens the registry/messages over sqlite', async () => {
    const { ctx, hub, port } = await harness({ mesh: false })
    expect(hub).toBeDefined()
    expect(port).toBeGreaterThan(0)
    expect(hub!.registryService.listProjects()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('mounts the mesh client with the tool surface', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    const tools: unknown[] = []
    ctx.provide('tools', { register: (definition: unknown) => {
      tools.push(definition)
      return () => {}
    } } as never)
    const agent = { id: 'agent-a', status: 'idle', followup: vi.fn(), inject: vi.fn() }
    ctx.provide('agents', { get: () => agent } as never)
    await ctx.plugin(s2sApply, {
      hub: { host: '127.0.0.1', port: 0 },
      mesh: { hubUrl: 'http://127.0.0.1:1', project: 'mesh', agentId: 'agent-a' },
    })
    const mesh = ctx.get('s2sMesh') as S2sMeshService
    expect(mesh).toBeDefined()
    await vi.waitFor(() => {
      expect(tools).toHaveLength(3)
    }, { timeout: 2000 })
    expect(tools.map(t => (t as { name: string }).name)).toEqual(['s2s_peers', 's2s_message', 's2s_history'])
    await ctx.fiber.dispose()
  })

  it('mounts the hub service without a server config', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    await ctx.plugin(S2sHubHostService)
    const hub = ctx.get('s2sHub') as S2sHubHostService
    expect(hub.port).toBeUndefined()
    expect(hub.url).toBeUndefined()
    await vi.waitFor(() => {
      expect(hub.registryService.listProjects()).toEqual([])
    })
    await ctx.fiber.dispose()
  })

  it('mounts the hub server with a default host', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    await ctx.plugin(s2sApply, { hub: { port: 0 } })
    const hub = ctx.get('s2sHub') as S2sHubHostService
    await vi.waitFor(() => {
      if (hub.port === undefined) throw new Error('hub not listening')
    }, { timeout: 2000 })
    expect(hub.port).toBeGreaterThan(0)
    expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`)
    await ctx.fiber.dispose()
  })

  it('mounts the hub with a maxPort range', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    await ctx.plugin(s2sApply, { hub: { host: '127.0.0.1', port: 0, maxPort: 65535 } })
    const hub = ctx.get('s2sHub') as S2sHubHostService
    await vi.waitFor(() => {
      if (hub.port === undefined) throw new Error('hub not listening')
    }, { timeout: 2000 })
    expect(hub.port).toBeGreaterThan(0)
    expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`)
    await ctx.fiber.dispose()
  })

  it('mounts the mesh client without a hub host', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    const agent = { id: 'agent-a', status: 'idle', followup: vi.fn(), inject: vi.fn() }
    ctx.provide('agents', { get: () => agent } as never)
    await ctx.plugin(s2sApply, {
      mesh: { hubUrl: 'http://127.0.0.1:1', project: 'mesh', agentId: 'agent-a' },
    })
    expect(ctx.get('s2sHub')).toBeUndefined()
    expect(ctx.get('s2sMesh')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('follows the in-process hub when the mesh omits hubUrl', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    const agent = { id: 'agent-a', status: 'idle', followup: vi.fn(), inject: vi.fn() }
    ctx.provide('agents', { get: () => agent } as never)
    await ctx.plugin(s2sApply, {
      hub: { host: '127.0.0.1', port: 0 },
      mesh: { project: 'mesh', agentId: 'agent-a' },
    })
    const hub = ctx.get('s2sHub') as S2sHubHostService
    await vi.waitFor(() => {
      if (hub.port === undefined) throw new Error('hub not listening yet')
    }, { timeout: 2000 })
    await hub.registryService.createProject('mesh')
    const mesh = ctx.get('s2sMesh') as S2sMeshService
    const status = await mesh.connect('agent-a')
    expect(status.connected).toBe(true)
    if (!status.connected) throw new Error('expected a live mesh connection')
    expect(status.project).toBe('mesh')
    await mesh.disconnect()
    await ctx.fiber.dispose()
  })

  it('fails loud when the mesh omits hubUrl and no hub is mounted', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    const agent = { id: 'agent-a', status: 'idle', followup: vi.fn(), inject: vi.fn() }
    ctx.provide('agents', { get: () => agent } as never)
    await ctx.plugin(s2sApply, {
      mesh: { project: 'mesh', agentId: 'agent-a' },
    })
    const mesh = ctx.get('s2sMesh') as S2sMeshService
    await expect(mesh.connect('agent-a')).rejects.toThrow(/no hubUrl/)
    await ctx.fiber.dispose()
  })

  it('ignores legacy 0.2 mesh config fields at load', async () => {
    const ctx = new Context()
    await mountStorage(ctx)
    // 0.2 fields name behaviors that no longer exist; they are ignored so a
    // copied old cordis.yml keeps loading without a breaking error.
    await expect(ctx.plugin(s2sApply, {
      mesh: {
        hubUrl: 'http://127.0.0.1:1',
        project: 'mesh',
        agentId: 'agent-a',
        persistBindings: true,
        autoRejoin: true,
        pollIntervalMs: 1000,
        heartbeatMs: 5000,
        caps: ['api'],
      } as never,
    })).resolves.toBeTruthy()
    await ctx.fiber.dispose()
  })

  it('drives a full round trip through the composed services', async () => {
    const { ctx, port } = await harness({ mesh: false })
    try {
      const hub = ctx.get('s2sHub') as S2sHubHostService
      await hub.registryService.createProject('mesh')
      const senderAgent = { id: 'sender', status: 'idle', followup: vi.fn(), inject: vi.fn() }
      const sender = new Context()
      sender.provide('agents', { get: () => senderAgent } as never)
      const senderMesh = new S2sMeshService(sender, {
        hubUrl: `http://127.0.0.1:${port}`,
        project: 'mesh',
      })
      await senderMesh.connect('sender', 'mesh', 'api')
      // Sending to an absent name fails immediately — no latent work.
      await expect(senderMesh.message({
        from: 'sender',
        target: { type: 'agent', name: 'nobody' },
        text: 'hello',
      })).rejects.toThrow(/recipient is not present/)
      // Broadcasts land in the message store even with no recipients.
      const accepted = await senderMesh.message({
        from: 'sender',
        target: { type: 'project' },
        text: 'hello',
      })
      expect(accepted.message.messageRef).toBe('mesh:1')
      const stored = hub.messagesService.get('mesh:1')
      expect(stored).not.toBeNull()
      expect(decodeTextPayload(stored!.payload)).toBe('hello')
      await senderMesh.disconnect('sender')
      await sender.fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

it('logs the domain-open failure loud when the hub cannot start', async () => {
  const ctx = new Context()
  const errors: unknown[] = []
  ctx.logger.error = ((message: unknown) => { errors.push(message) }) as typeof ctx.logger.error
  // The storage service is present but its open refuses (a version-
  // mismatched medium): the hub's activation failure surfaces as an
  // explicit error instead of a silent hub-less mesh.
  ctx.provide('storageDomain', {
    open: async () => { throw new Error('version mismatch: medium stamped 2, spec 3') },
  } as never)
  await ctx.plugin(s2sApply, { hub: { host: '127.0.0.1', port: 0 } })
  await vi.waitFor(() => {
    expect(errors.some(message => String(message).includes('s2sHub: failed to open'))).toBe(true)
  }, { timeout: 2000 })
  await ctx.fiber.dispose()
})
