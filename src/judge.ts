/**
 * Real semantic judge for the s2s budget: a one-shot model call through the
 * harness llm seam, reading the recent (from,to) exchange and returning a
 * strict verdict. Any failure throws — the budget degrades to its counting caps.
 * @module dsh-s2s/judge
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { S2sJudge, S2sJudgeRequest, S2sThreadEntry, S2sVerdict } from './budget.ts'

/** Judge directive: the only acceptable output is one JSON verdict object. */
export const JUDGE_SYSTEM = [
  'You are a frugality guard overseeing a back-and-forth between two AI sessions.',
  'Decide whether the recent exchange is worth continuing to spend tokens on.',
  'A meaningful exchange produces at least one of: new information or facts, a decision,',
  'an artifact (plan/code/file), a real tradeoff, or a concrete next action.',
  'A meaningless token-burn repeats the same point, purely acknowledges, reads state back,',
  'or exchanges pleasantries with no new information and no action.',
  'Answer ONLY with a JSON object: {"meaningful":<bool>,"confidence":<0..1>,"reason":"<short reason>"}.',
].join(' ')

/** Human/audit-friendly prompt: the recent exchange lines plus the rubric. */
export function judgePrompt(thread: readonly S2sThreadEntry[]): string {
  const lines = thread.map(t => `[${new Date(t.at).toISOString()}] ${t.from}: ${t.text}`).join('\n')
  return [
    'Recent exchange between the two sessions (oldest first):',
    lines,
    '',
    'Rubric: meaning = new info/decision/artifact/tradeoff/action; token-burn = repetition/acknowledgement/state-readback with no new info.',
    'Respond with the JSON verdict only.',
  ].join('\n')
}

/** Parse a strict verdict object out of the model output (tolerates code fences). */
export function parseVerdict(text: string): S2sVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) throw new Error('s2s judge: no JSON object in model output')
  const raw = JSON.parse(match[0]) as { meaningful?: unknown; confidence?: unknown; reason?: unknown }
  const confidence = Number(raw.confidence)
  return {
    meaningful: Boolean(raw.meaningful),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  }
}

/** Build the real semantic judge bound to a host context (reads ctx.llm lazily). */
export function buildSemanticJudge(ctx: Context): S2sJudge {
  return async (req: S2sJudgeRequest): Promise<S2sVerdict> => {
    const provider = req.model?.provider
    const model = req.model?.model
    if (provider === undefined || model === undefined) throw new Error('s2s judge: no sender model to judge with')
    const ctxAny = ctx as unknown as { get?: (key: string) => unknown; llm?: unknown }
    const llm = ctxAny.get?.('llm') ?? ctxAny.llm
    if (llm === undefined) throw new Error('s2s judge: llm service unavailable')
    const generate = (llm as { stream: (req: GenerateOptions) => AsyncIterable<StreamChunk> }).stream
    const request: GenerateOptions = {
      provider,
      model,
      system: JUDGE_SYSTEM,
      messages: [createUserMessage({ content: [{ type: 'text', text: judgePrompt(req.thread) }], source: { kind: 'user' } })],
    }
    const assembler = new BlockAssembler()
    for await (const chunk of generate(request)) assembler.push(chunk)
    const text = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => (block as unknown as { text: string }).text)
      .join('')
    return parseVerdict(text)
  }
}
