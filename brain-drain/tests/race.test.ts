// Hooks that run together after a /clear: one seeding however many ask for it,
// a seeding held up by a slow file move, and a SessionStart that arrives
// before the engine's session id has switched.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HOME, SID, sessionFile, settle, sleep, start, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const NEW = '99999999-0000-0000-0000-000000000000'
const PRIMARY = `${HOME}/.claude/fuel-gauge`
const STEP_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 300000, cache_creation_input_tokens: 12000, model: 'claude-opus-5-5' }
const ACCOUNT_1H = JSON.stringify({ detected_ttl: 3600, detected_at: Date.UTC(2026, 9, 3, 11) / 1000 })
const ROW_1H = JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T11:30:00Z',
  message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 34038, ephemeral_5m_input_tokens: 0 } } } })
const ROW_5M = JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T11:35:00Z',
  message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 34038 } } } })
const CMD = (args: string) => ({ command: 'drain', args, origin: { kind: 'composer' } as never, presentation: {} as never })

// Each seeding prunes the miss ledger once, which lists the store's keys once: the count of seedings.
// The /drain report lists them too, so these tests do not ask for it while counting.
let keysCalls = 0
class CountingMap extends Map<string, unknown> {
  override keys(): MapIterator<string> {
    keysCalls++
    return super.keys()
  }
}

function host(on: On, o: WorldOptions = {}): World {
  const w = world(on, o)
  w.store = new CountingMap(w.store)
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('prompt.submit', ($2: unknown, e: unknown) => e as never)
  return w
}

async function step($: Engine, turnId = 't'): Promise<void> {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
}

async function drain($: Engine, args = ''): Promise<string> {
  return ((await $.command.run(CMD(args))) as { text: string }).text
}

test('one seeding when SessionStart, a tick, a request and two commands land together after a /clear', async ($, on) => {
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 }, files: { [`${PRIMARY}/account_ttl.json`]: ACCOUNT_1H } })
  await start($)
  await step($)
  await settle()
  const before = keysCalls
  w.clear(NEW)
  await Promise.all([
    $.classic.SessionStart({ source: 'clear', transcript_path: `/t/${NEW}.jsonl` } as never),
    w.clock.advance(1000),
    step($, 't2'),
    drain($, 'help'),
    drain($, 'bars'),
  ])
  await settle()
  expect(keysCalls - before).toBe(1)
  expect(sessionFile(w, PRIMARY, NEW)).toMatchObject({ session_id: NEW, detected_ttl: 3600 })
  expect(w.store.get('prefs')).toMatchObject({ style: 'bars', warnSeconds: 60, sound: false })
})

test('hooks waiting on a seeding held up by the file move all finish once it moves, with one seeding', async ($, on) => {
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 } })
  await start($)
  await step($)
  await settle()
  const before = keysCalls
  let release!: () => void
  w.mvGate = new Promise<void>(r => { release = r })
  w.clear(NEW)
  let done = false
  const pending = Promise.all([
    $.classic.SessionStart({ source: 'clear', transcript_path: `/t/${NEW}.jsonl` } as never),
    w.clock.advance(1000),
    step($, 't2'),
    drain($, 'help'),
    $.prompt.submit({ text: 'hi' } as never),
  ]).then(() => { done = true })
  await sleep(100)
  expect(done).toBe(false)
  release()
  w.mvGate = undefined
  await pending
  await settle()
  expect(keysCalls - before).toBe(1)
  expect(sessionFile(w, PRIMARY, NEW)).toMatchObject({ session_id: NEW })
})

test('a SessionStart that arrives before the session id switches keeps the new transcript path', async ($, on) => {
  const w = host(on, { context: { tokens: 310000, window: 1000000, percent: 31 }, files: { [`/t/${NEW}.jsonl`]: ROW_1H } })
  await start($)
  await $.classic.SessionStart({ source: 'startup', transcript_path: `/t/${SID}.jsonl` } as never)
  await step($)
  await settle()
  await w.clock.advance(5000)
  // The state is blank and the event names the new transcript, but the engine still gives the old id.
  w.clear(NEW)
  w.sid = SID
  await $.classic.SessionStart({ source: 'clear', transcript_path: `/t/${NEW}.jsonl` } as never)
  await settle()
  w.sid = NEW
  await w.clock.advance(1000)
  await settle()
  // A Stop that carries no path reads the transcript the mod remembers.
  w.files.set(`/t/${NEW}.jsonl`, ROW_5M)
  await $.classic.Stop({} as never)
  await settle()
  expect(await drain($)).toContain('TTL 5m (transcript)')
})
