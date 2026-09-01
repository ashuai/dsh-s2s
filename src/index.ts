/**
 * dsh-s2s entry plugin: same-host session-to-session interconnection.
 * No hub / network mesh — delivery is in-process via S2sBroker; dormant
 * sessions are woken via AgentRegistry.resume (lifecycle); names (titles)
 * address sessions (discovery). Config blocks gate optional features, so
 * a bare mount is just the broker + discovery + tools.
 * @module dsh-s2s
 */
import type { Context } from '@deepseek-ai/cordis'
import './types.ts'
import { S2sBroker } from './broker.ts'
import { S2sDiscoveryService } from './discovery.ts'
import { S2sLifecycleService, type LifecycleConfig } from './lifecycle.ts'
import { S2sBudget, type BudgetConfig } from './budget.ts'
import * as toolsPlugin from './tools.ts'

export { S2sError } from './error.ts'
export type { S2sErrorCode } from './error.ts'
export { S2sBroker } from './broker.ts'
export type { S2sDeliverInput, S2sBrokerRecord, S2sDeliverState } from './broker.ts'
export { S2sDiscoveryService, DEFAULT_SESSIONS_ROOT } from './discovery.ts'
export type { S2sSessionInfo, S2sResolveResult } from './discovery.ts'
export { S2sLifecycleService } from './lifecycle.ts'
export type { LifecycleConfig } from './lifecycle.ts'
export { S2sMailbox } from './mailbox.ts'
export type { MailboxEntry } from './mailbox.ts'
export { S2sBudget } from './budget.ts'
export type { BudgetConfig } from './budget.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-s2s'

/** Services the entry plugin itself consumes (children declare their own). */
export const inject: string[] = []

/** One plugin configuration: broker + discovery always on; lifecycle/budget optional. */
export interface Config {
  readonly lifecycle?: { enabled?: boolean; autoResume?: string; mailboxDir?: string }
  readonly budget?: BudgetConfig
}

/**
 * Mount the s2s core: the in-process broker + session discovery + tools, and
 * (when configured) the lifecycle wake path and the anti-loop budget.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(S2sBroker)
  ctx.plugin(S2sDiscoveryService)
  if (config.lifecycle !== undefined) {
    ctx.plugin(S2sLifecycleService, {
      ...(config.lifecycle.enabled === undefined ? {} : { enabled: config.lifecycle.enabled }),
      autoResume: config.lifecycle.autoResume === 'allow' ? 'allow' : 'deny',
      ...(config.lifecycle.mailboxDir === undefined ? {} : { mailboxDir: config.lifecycle.mailboxDir }),
    })
  }
  if (config.budget !== undefined) {
    ctx.provide('s2sBudget', new S2sBudget(config.budget))
  }
  ctx.plugin(toolsPlugin)
}

