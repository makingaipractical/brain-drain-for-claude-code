import { expect, test } from 'claude-code/testing'
import * as core from '../hooks/core.ts'
import { register } from '../hooks/register.tsx'
import { HOME, ROOT, SID, start, transcript, world } from './world.ts'

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const usage = (h1: number, m5: number, ts: string, side = false) =>
  row({ type: 'assistant', isSidechain: side, timestamp: ts, message: { usage: { cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } } } })

test('the last main-thread cache write decides the TTL', () => {
  const tail = [usage(0, 900, '2026-10-03T10:00:00.000Z'), usage(34038, 0, '2026-10-03T11:00:00.000Z'), row({ type: 'user', text: 'x' })].join('\n')
  expect(core.ttlFromTail(tail, false)).toEqual({ ttl: 3600, atS: Date.UTC(2026, 9, 3, 11) / 1000 })
})

test('a subagent row is skipped, the 5-minute tier found', () => {
  const tail = [usage(0, 500, '2026-10-03T10:00:00Z'), usage(9000, 0, '2026-10-03T10:01:00Z', true)].join('\n')
  expect(core.ttlFromTail(tail, false)?.ttl).toBe(300)
})

test('a cut first line is dropped and no row means no answer', () => {
  const half = usage(9000, 0, '2026-10-03T10:00:00Z').slice(10)
  expect(core.ttlFromTail(`${half}\n{"type":"user"}`, true)).toBeUndefined()
  expect(core.ttlFromTail('not json ephemeral_\n', false)).toBeUndefined()
})

test('account_ttl.json is written only by a newer, different observation', () => {
  expect(core.shouldWriteAccountTtl(undefined, 3600, 100)).toBe(true)
  expect(core.shouldWriteAccountTtl({ detected_ttl: 3600, detected_at: 50 }, 3600, 100)).toBe(false)
  expect(core.shouldWriteAccountTtl({ detected_ttl: 3600, detected_at: 500 }, 300, 100)).toBe(false)
  expect(core.shouldWriteAccountTtl({ detected_ttl: 3600, detected_at: 50 }, 300, 100)).toBe(true)
})

test('the turn end reads the TTL from the transcript tail, widening past a big row', async ($, on) => {
  const path = transcript()
  // The usage row sits behind a 100 kB row, beyond the first 64 kB window.
  const rows = [usage(34038, 0, '2026-10-03T11:00:00Z'), row({ type: 'attachment', blob: 'x'.repeat(100000) })].join('\n')
  const w = world(on, { files: { [path]: rows } })
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  const tails = w.runs.filter(r => r[0] === 'tail').map(r => r[2])
  expect(tails).toEqual(['65536', '262144'])
  const file = JSON.parse(w.files.get(`${HOME}/.claude/fuel-gauge/${SID}.json`)!)
  expect(file.detected_ttl).toBe(3600)
  expect(JSON.parse(w.files.get(`${HOME}/.claude/fuel-gauge/account_ttl.json`)!)).toEqual({ detected_ttl: 3600, detected_at: Date.UTC(2026, 9, 3, 11) / 1000 })
  expect(file.project_dir).toBe(ROOT)
})

// MC-5779: a managed plugin above skips classic hooks on a Team login, and
// Claude Code prints a line for each one it skips. The mod registers none.
test('the mod registers no classic hook', () => {
  const names: string[] = []
  register(((name: string) => { names.push(name) }) as never, {} as never)
  expect(names).toContain('turn.complete')
  expect(names.filter(n => n.startsWith('classic.'))).toEqual([])
})

// MC-5712: no event names the transcript, so the mod finds it where Claude Code keeps it.
test('the turn end finds the transcript and reads the TTL', async ($, on) => {
  const path = transcript()
  const w = world(on, { files: { [path]: usage(34038, 0, '2026-10-03T11:00:00Z') } })
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  const file = JSON.parse(w.files.get(`${HOME}/.claude/fuel-gauge/${SID}.json`)!)
  expect(file.detected_ttl).toBe(3600)
  expect(w.runs.some(r => r[0] === 'tail' && r.includes(path))).toBe(true)
})

test('with CLAUDE_CONFIG_DIR set, the transcript is found under it', async ($, on) => {
  const path = `/cfg/projects/-work-proj/${SID}.jsonl`
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg/' }, files: { [path]: usage(34038, 0, '2026-10-03T11:00:00Z') } })
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  expect(JSON.parse(w.files.get(`${HOME}/.claude/fuel-gauge/${SID}.json`)!).detected_ttl).toBe(3600)
  expect(w.runs.some(r => r[0] === 'tail' && r.includes(path))).toBe(true)
})

test('a subagent turn end reads no transcript', async ($, on) => {
  const path = transcript()
  const w = world(on, { files: { [path]: usage(34038, 0, '2026-10-03T11:00:00Z') } })
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await $.turn.complete({ turnId: 'sub', agentId: 'a1', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  expect(w.runs.some(r => r[0] === 'tail')).toBe(false)
})

// S4: a cache kept warm by something else must not pass for the 1-hour tier while the transcript says 5 minutes.
test('the warm-gap upgrade defers to the transcript', async ($, on) => {
  const path = transcript()
  const w = world(on, { files: { [path]: '' } })
  let step = { cache_read_input_tokens: 0, cache_creation_input_tokens: 50000 }
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, model: 'claude-opus-5-5', ...step } } as never
  })
  await start($)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  // The first request's row lands on the 5-minute tier; no turn end has read it yet.
  w.files.set(path, usage(0, 50000, '2026-10-03T12:00:00Z'))
  await w.clock.advance(583_000)
  step = { cache_read_input_tokens: 173531, cache_creation_input_tokens: 1000 }
  for await (const _ of $.turn.step({ turnId: 't', index: 1, model: 'claude-opus-5-5', messageCount: 3 })) { /* drain */ }
  const file = JSON.parse(w.files.get(`${HOME}/.claude/fuel-gauge/${SID}.json`)!)
  expect(file.detected_ttl).toBe(300)
})
