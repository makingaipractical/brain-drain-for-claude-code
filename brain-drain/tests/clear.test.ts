// /clear and a /resume in the same process, as Claude Code 2.1.300 does them: a
// new session id, every `$.state` value empty, and no session.start. The mod has
// no classic hook (#5779), so its 1-second tick notices the new id.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BRIDGE_SETTINGS, HOME, SID, sessionFile, settle, start, transcript, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const NEW = '99999999-0000-0000-0000-000000000000'
const SHADOW = `${HOME}/.claude/fuel-gauge-mod`
const PRIMARY = `${HOME}/.claude/fuel-gauge`
const STEP_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 300000, cache_creation_input_tokens: 12000, model: 'claude-opus-5-5' }
const ACCOUNT_1H = JSON.stringify({ detected_ttl: 3600, detected_at: Date.UTC(2026, 9, 3, 11) / 1000 })
const ROW_1H = JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T11:30:00Z',
  message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 34038, ephemeral_5m_input_tokens: 0 } } } })
const CMD = (args: string) => ({ command: 'drain', args, origin: { kind: 'composer' } as never, presentation: {} as never })

function host(on: On, o: WorldOptions = {}): World {
  const w = world(on, o)
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  return w
}

async function step($: Engine, turnId = 't'): Promise<void> {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  await settle()
}

async function drain($: Engine, args = ''): Promise<string> {
  return ((await $.command.run(CMD(args))) as { text: string }).text
}

/** The host's /clear (or a /resume) into `sid`, and the tick that follows it. */
async function clear(w: World, sid = NEW): Promise<void> {
  w.clear(sid)
  await w.clock.advance(1000)
  await settle()
}

test('after a /clear the new session file is written to the shadow directory while the bridge is live', async ($, on) => {
  const w = host(on, { settings: BRIDGE_SETTINGS, context: { tokens: 310000, window: 1000000, percent: 31 } })
  await start($)
  await step($)
  w.context = { window: 1000000 }
  await clear(w)
  expect(sessionFile(w, SHADOW, NEW)).toMatchObject({ writer: 'mod', session_id: NEW, used_percentage: 0 })
  expect(sessionFile(w, PRIMARY, NEW)).toBeUndefined()
  expect(await drain($)).toContain('(shadow copy:')
})

test('after a /clear the new session file is written to the extension directory once the bridge is unwired', async ($, on) => {
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 } })
  await start($)
  await step($)
  w.context = { window: 1000000 }
  await clear(w)
  expect(sessionFile(w, PRIMARY, NEW)).toMatchObject({ writer: 'mod', session_id: NEW })
  expect(sessionFile(w, SHADOW, NEW)).toBeUndefined()
  expect(await drain($)).not.toContain('not an interactive session')
})

test('after a /clear the cache clock uses the account TTL before any request, not the 5-minute default', async ($, on) => {
  const w = host(on, { settings: BRIDGE_SETTINGS, files: { [`${PRIMARY}/account_ttl.json`]: ACCOUNT_1H } })
  await start($)
  await clear(w)
  expect(await drain($)).toContain('TTL 1h (account)')
  expect(sessionFile(w, SHADOW, NEW)).toMatchObject({ detected_ttl: 3600 })
})

test('after a /clear the TTL is read from the new session\'s transcript', async ($, on) => {
  const w = host(on, { files: { [transcript(NEW)]: ROW_1H } })
  await start($)
  await clear(w)
  expect(await drain($)).toContain('TTL 1h (transcript)')
  expect(sessionFile(w, PRIMARY, NEW)).toMatchObject({ detected_ttl: 3600 })
})

test('the first request after a /clear gives a percentage, though no SessionStart came', async ($, on) => {
  const w = host(on)
  await start($)
  w.clear(NEW)
  await step($)
  expect(sessionFile(w, PRIMARY, NEW)).toMatchObject({ used_percentage: 31, context_window_size: 1000000 })
  expect(await drain($, 'styles')).toContain('with this session\'s figures')
})

test('the stored style survives a /clear, and a /drain change after it keeps the other stored prefs', async ($, on) => {
  const w = host(on, { store: { prefs: { style: 'bars', sound: true, warnSeconds: 90 } } })
  await start($)
  await clear(w)
  const report = await drain($)
  expect(report).toContain('style bars')
  expect(report).toContain('alert 90 s')
  expect(report).toContain('sound on')
  await drain($, 'gauge')
  expect(w.store.get('prefs')).toMatchObject({ style: 'gauge', sound: true, warnSeconds: 90 })
})

test('a /resume in the same process reads the mod\'s own earlier file for that session', async ($, on) => {
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 }, files: { [`${PRIMARY}/account_ttl.json`]: ACCOUNT_1H } })
  await start($)
  await step($)
  const before = sessionFile(w, PRIMARY, SID)!
  expect(before).toMatchObject({ detected_ttl: 3600, used_percentage: 31, model: 'claude-opus-5-5' })
  w.context = { window: 1000000 }
  await clear(w)
  await clear(w, SID)
  expect(await drain($)).toContain('TTL 1h (previous)')
  expect(await drain($, 'styles')).toContain('with this session\'s figures')
  expect(sessionFile(w, PRIMARY, SID)).toMatchObject({ used_percentage: 31, model: 'claude-opus-5-5', last_api_call_ts: before.last_api_call_ts })
})

test('the timers are registered once: a /clear does not add a second tick', async ($, on) => {
  // The mock clock answers clock.every, so the ticks are counted by what they do: one redraw a second.
  const w = host(on)
  await start($)
  await step($)
  const n0 = w.invalidates
  await w.clock.advance(1000)
  const perSecond = w.invalidates - n0
  expect(perSecond).toBeGreaterThan(0)
  await clear(w)
  await step($, 't2')
  const n1 = w.invalidates
  await w.clock.advance(1000)
  expect(w.invalidates - n1).toBe(perSecond)
})

test('a host that keeps $.state across /clear still follows the id, and nothing is seeded again', async ($, on) => {
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 }, files: { [`${PRIMARY}/account_ttl.json`]: ACCOUNT_1H } })
  await start($)
  await step($)
  // Seeding again would pick this up; the kept state must not.
  w.store.set('prefs', { style: 'bars' })
  w.context = { window: 1000000 }
  w.sid = NEW
  await w.clock.advance(1000)
  await settle()
  expect(sessionFile(w, PRIMARY, NEW)).toMatchObject({ session_id: NEW, used_percentage: 0, last_api_call_ts: 0 })
  w.sid = SID
  await w.clock.advance(1000)
  await settle()
  const report = await drain($)
  expect(report).toContain('TTL 1h (previous)')
  expect(report).toContain('style minimal')
  expect(sessionFile(w, PRIMARY, SID)).toMatchObject({ used_percentage: 31, model: 'claude-opus-5-5' })
})

test('a session that did not report itself interactive stays without a file after a /clear', async ($, on) => {
  // An attached surface, as in Anthropic's VS Code chat panel, though session.start said not interactive.
  const w = host(on)
  await start($, false)
  await clear(w)
  await step($)
  expect(sessionFile(w, PRIMARY, NEW)).toBeUndefined()
  expect(sessionFile(w, SHADOW, NEW)).toBeUndefined()
  expect(await drain($)).toContain('not an interactive session')
})

test('an in-process /resume is followed within a second, with no event and no request', async ($, on) => {
  // Claude Code 2.1.300 keeps $.state on an in-process /resume and tells the mod nothing until the next request.
  const RES = '77777777-0000-0000-0000-000000000000'
  const lastApi = Date.UTC(2026, 9, 3, 11, 40) / 1000
  const own = JSON.stringify({ writer: 'mod', session_id: RES, used_percentage: 42, context_window_size: 1000000,
    detected_ttl: 3600, last_api_call_ts: lastApi, model: 'claude-sonnet-5-5' })
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 }, files: { [`${PRIMARY}/${RES}.json`]: own } })
  await start($)
  await step($)
  w.context = { window: 1000000 }
  w.sid = RES
  await w.clock.advance(1000)
  await settle()
  expect(w.files.get(`${PRIMARY}/${RES}.json`)).not.toBe(own)
  expect(sessionFile(w, PRIMARY, RES)).toMatchObject({ session_id: RES, used_percentage: 42, last_api_call_ts: lastApi, detected_ttl: 3600, model: 'claude-sonnet-5-5' })
  expect(await drain($)).toContain('TTL 1h (previous)')
})

test('a hook before session.start writes nothing; session.start then seeds the true value and writes the file', async ($, on) => {
  // A surface is attached, as in the VS Code chat panel, so a guess from surfaces would say interactive.
  const w = host(on)
  await step($)
  expect(sessionFile(w, PRIMARY, SID)).toBeUndefined()
  expect(sessionFile(w, SHADOW, SID)).toBeUndefined()
  await start($)
  expect(sessionFile(w, PRIMARY, SID)).toMatchObject({ writer: 'mod', session_id: SID })
  expect(await drain($)).not.toContain('not an interactive session')
})

