import { expect, test } from 'claude-code/testing'
import type { TurnStepResult } from 'claude-code'
import * as core from '../hooks/core.ts'
import { start, world, settle, SID } from './world.ts'

// MC-4986: the fill used to change only at session.measure, which fires after a
// turn, so every write inside a long turn carried the turn's first request.

test('the fill is the three input counters over the window, rounded', () => {
  const u = { input_tokens: 2, cache_read_input_tokens: 177000, cache_creation_input_tokens: 1592 }
  expect(core.stepFill(u, 1000000)).toEqual({ tokens: 178594, percent: 18, unknown: false })
  expect(core.stepFill(u, undefined)).toEqual({ tokens: 178594, unknown: false })
})

test('two requests with no measure between: the file carries the second one', async ($, on) => {
  const w = world(on, { context: { tokens: 100000, window: 1000000, percent: 10 } })
  let next: TurnStepResult['usage'] = null
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }): AsyncGenerator<never, TurnStepResult> {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'tool_use', usage: next }
  })
  const step = async (index: number, read: number, wrote: number) => {
    next = { input_tokens: 2, output_tokens: 4, model: 'claude-opus-5-5', cache_read_input_tokens: read, cache_creation_input_tokens: wrote }
    for await (const _ of $.turn.step({ turnId: 't', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) { /* drain */ }
    await settle()
    return JSON.parse(w.files.get(`/h/.claude/fuel-gauge/${SID}.json`)!)
  }
  await start($)
  const first = await step(0, 166000, 1702)
  expect(first).toMatchObject({ total_input_tokens: 167704, used_percentage: 17 })
  await w.clock.advance(30_000)
  const second = await step(1, 177000, 1592)
  expect(second).toMatchObject({ total_input_tokens: 178594, used_percentage: 18, remaining_percentage: 82 })
})
