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
