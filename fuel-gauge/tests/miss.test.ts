import { expect, test } from 'claude-code/testing'
import type { TurnStepResult } from 'claude-code'
import * as core from '../hooks/core.ts'
import { start, world } from './world.ts'

const cold = { cache_read_input_tokens: 9000, cache_creation_input_tokens: 150000 }
const warm = { cache_read_input_tokens: 149000, cache_creation_input_tokens: 5000 }

test('first request of a new or resumed session is never a miss', () => {
  expect(core.classifyStep({ observed: false, lastApiS: 100, ttl: 300 }, 100000, cold)).toBe('first')
  expect(core.classifyStep({ observed: true, lastApiS: undefined, ttl: 300 }, 100000, cold)).toBe('first')
})

test('a re-write after the TTL is a miss; inside the TTL or served warm is not', () => {
  expect(core.classifyStep({ observed: true, lastApiS: 1000, ttl: 300 }, 1301, cold)).toBe('miss')
  expect(core.classifyStep({ observed: true, lastApiS: 1000, ttl: 300 }, 1299, cold)).toBe('warm')
  expect(core.classifyStep({ observed: true, lastApiS: 1000, ttl: 300 }, 5000, warm)).toBe('warm')
  expect(core.classifyStep({ observed: true, lastApiS: 1000, ttl: 300 }, 5000, { cache_read_input_tokens: 0, cache_creation_input_tokens: 500 })).toBe('warm')
})

test('the ledger reports today and the last 7 days', () => {
  const now = Date.UTC(2026, 9, 3, 18) / 1000
  const lines = core.ledgerReport([
    { at: now - 60, session: 's', project: 'p', tokens: 150000, gapS: 4000, ttl: 3600, costUsd: 0.9 },
    { at: now - 3 * 86400, session: 's', project: 'p', tokens: 50000, gapS: 400, ttl: 300 },
  ], now)
  expect(lines[0]).toBe('Today:        1 miss · 150k tokens re-written · $0.90 measured (1 of 1)')
  expect(lines[1]).toBe('Last 7 days:  2 misses · 200k tokens re-written · $0.90 measured (1 of 2)')
})

function stepper($: any, on: any) {
  let next: TurnStepResult['usage'] = null
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }): AsyncGenerator<never, TurnStepResult> {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: next }
  })
  return async (u: typeof cold) => {
    next = { input_tokens: 2, output_tokens: 4, model: 'claude-opus-5-5', ...u }
    const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
    for await (const _ of s) { /* drain */ }
  }
}

test('turn.step records a miss after an idle gap, never on the first request', async ($, on) => {
  const w = world(on, { files: { '/h/.claude/fuel-gauge/account_ttl.json': '{"detected_ttl":300,"detected_at":1}' } })
  const step = stepper($, on)
  await start($)
  await step(cold) // first request: not a miss
  await w.clock.advance(60_000)
  await step(warm) // warm
  await w.clock.advance(400_000)
  await step(cold) // 400 s idle on a 5-minute TTL: miss
  const keys = [...w.store.keys()].filter(k => k.startsWith('miss:'))
  expect(keys).toHaveLength(1)
  const miss = w.store.get(keys[0]!) as { tokens: number; gapS: number; ttl: number }
  expect(miss).toMatchObject({ tokens: 150000, gapS: 400, ttl: 300 })
  const file = JSON.parse(w.files.get(`/h/.claude/fuel-gauge/abcdef12-0000-0000-0000-000000000000.json`)!)
  expect(file).toMatchObject({ effort_level: 'high', model: 'claude-opus-5-5', cache_creation_input_tokens: 150000, writer: 'mod', detected_ttl: 300 })
  expect(file.last_api_call_ts).toBe(w.clock.now() / 1000)
})
