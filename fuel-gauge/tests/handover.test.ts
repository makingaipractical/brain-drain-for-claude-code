import { expect, test } from 'claude-code/testing'
import * as core from '../hooks/core.ts'
import { BRIDGE_SETTINGS, HOME, SID, sessionFile, start, world } from './world.ts'

test('bridge detection', () => {
  expect(core.bridgeLive(BRIDGE_SETTINGS)).toBe(true)
  expect(core.bridgeLive({ statusLine: { type: 'command', command: '~/my-line.sh' } })).toBe(false)
  expect(core.bridgeLive({})).toBe(false)
  expect(core.outDirFor('/h', true)).toBe('/h/.claude/fuel-gauge-mod')
  expect(core.outDirFor('/h', false)).toBe('/h/.claude/fuel-gauge')
})

test('while the bridge is the status line the mod writes the shadow directory only', async ($, on) => {
  const w = world(on, { settings: BRIDGE_SETTINGS, context: { tokens: 160000, window: 1000000, percent: 16 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 92, resetsAt: '2026-10-04T04:00:00Z' }] })
  await start($)
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge`)).toBeUndefined()
  const f = sessionFile(w, `${HOME}/.claude/fuel-gauge-mod`)
  expect(f).toMatchObject({ used_percentage: 16, total_input_tokens: 160000, context_window_size: 1000000, rate_limit_5h_pct: 92,
    rate_limit_5h_reset: Date.UTC(2026, 9, 4, 4) / 1000, rate_limit_7d_pct: -1, rate_limit_7d_reset: 0, writer: 'mod', session_id: SID })
  // Written beside the target, then moved into place.
  const mv = w.runs.find(r => r[0] === 'mv')!
  expect(mv[2]).toMatch(/fuel-gauge-mod\/abcdef12.*\.json\.mod-[a-z0-9]+\.tmp$/)
  expect([...w.files.keys()].some(k => k.endsWith('.tmp'))).toBe(false)
  expect([...w.files.keys()].some(k => k.includes('settings.json'))).toBe(false)
})

test('once the bridge is unwired the mod writes the extension directory', async ($, on) => {
  const w = world(on, { settings: { statusLine: { type: 'command', command: 'my-line.sh' } } })
  await start($)
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge`)).toMatchObject({ writer: 'mod' })
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge-mod`)).toBeUndefined()
})

test('without host commands the file is written in place', async ($, on) => {
  const w = world(on, { noProcess: true })
  await start($)
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge`)).toMatchObject({ writer: 'mod' })
})

const STEP_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 300000, cache_creation_input_tokens: 12000, model: 'claude-opus-5-5' }
const TRANSCRIPT_1H = JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T11:00:00Z',
  message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 34038, ephemeral_5m_input_tokens: 0 } } } })

// B1: the bridge never runs under `claude -p`, so the mod must not write there either.
test('a non-interactive run writes no session file, no account TTL, and spawns nothing', async ($, on) => {
  const w = world(on, { context: { tokens: 160000, window: 1000000, percent: 16 }, files: { '/t/s.jsonl': TRANSCRIPT_1H } })
  w.surfaces = []
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  await start($, false)
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/t/s.jsonl' } as never)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  await $.classic.Stop({ transcript_path: '/t/s.jsonl', stop_hook_active: false } as never)
  expect([...w.files.keys()].filter(k => k.startsWith(`${HOME}/.claude/`))).toEqual([])
  expect(w.runs).toEqual([])
})

// B2: session.start never fires on /clear, so the reading must follow the session id.
test('after /clear the new session file starts clean and the old one is left as it was', async ($, on) => {
  const w = world(on, { settings: BRIDGE_SETTINGS, context: { tokens: 310000, window: 1000000, percent: 31 } })
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  on('classic.SessionStart', () => ({}))
  await start($)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  const dir = `${HOME}/.claude/fuel-gauge-mod`
  const before = sessionFile(w, dir)!
  expect(before.used_percentage).toBe(31)
  expect(before.last_api_call_ts).toBeGreaterThan(0)
  const NEW = '99999999-0000-0000-0000-000000000000'
  w.sid = NEW
  w.context = { window: 1000000 }
  await $.classic.SessionStart({ source: 'clear', transcript_path: '/t/new.jsonl' } as never)
  const after = sessionFile(w, dir, NEW)!
  expect(after).toMatchObject({ session_id: NEW, used_percentage: 0, context_unknown: false, last_api_call_ts: 0, cache_creation_input_tokens: 0 })
  expect(after.model).toBe('claude-opus-5-5')
  expect(sessionFile(w, dir)).toEqual(before)
})
