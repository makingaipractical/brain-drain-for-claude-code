import { expect, test } from 'claude-code/testing'
import * as core from '../hooks/core.ts'
import * as notify from '../hooks/notify.ts'
import { HOME, SID, sessionFile, settle, start, world } from './world.ts'
import type { WorldOptions } from './world.ts'

// These push the clock through many simulated minutes, a second of tick at a time: about 1 to 3 s
// alone, and past the kit's 5 s default when the machine is busy (MC-8315).
const SLOW = { timeoutMs: 20_000 }

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
// Four days to the weekly reset: three days gone, so the pace line is 3/7 x 100 + 5 = 47.9%.
const LIMITS = (five: number, week: number) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: iso(NOW + 2 * 3600_000) },
  { kind: 'seven_day', percentUsed: week, resetsAt: iso(NOW + 4 * 86400_000) },
]
const PREFS = { style: 'bars', place: 'below', warnSeconds: 60, sound: false, agents: false }
// A user who turned the notice on in 0.2.1 and kept that release's thresholds: their block is kept as it is.
const ON = { prefs: { ...PREFS, notify: { on: true, context: [70, 90], fiveHour: [80, 95], week: true, margin: 5, text: {} } } }
// The block 0.2.1 saved along with any other /drain change, never touched.
const LEGACY = { prefs: { ...PREFS, notify: { on: false, context: [70, 90], fiveHour: [80, 95], week: true, margin: 5, text: {} } } }
const SUMMARY = [{ role: 'user', text: 'the conversation so far', toolUses: [] }] as never
// Who speaks, and the mark on a level's words (MC-6969).
const SRC = notify.NOTE_SOURCE.replace(/[.]/g, '\\.')
const P = notify.LEVEL_PREFIX
// The note's head: the account it names and the time it was read (MC-8006). No login record here.
const HEAD = String.raw`^Brain Drain, account not certain, read \d\d:\d\d: `
const CMD = (args: string) => ({ command: 'drain', args, origin: { kind: 'composer' } as never, presentation: {} as never })

async function setup($: any, on: any, o: WorldOptions = {}, interactive = true) {
  const w = world(on, { now: NOW, context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: LIMITS(50, 20), store: ON, ...o })
  on('prompt.submit', ($2: unknown, e: { text: string; context?: string[] }) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: { stdout: 'hi', stderr: '', interrupted: false } }))
  await start($, interactive)
  return w
}

const submit = async ($: any, text = 'go') => ((await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })) as { context?: string[] }).context ?? []
const toolCall = async ($: any, agentId?: string) =>
  ((await $.tool.call({ tool: 'Bash', input: { command: 'echo hi' }, ...(agentId ? { agentId } : {}) })) as { context?: string[] }).context ?? []

test('a mod hook hands the model text at prompt submit and after a tool call', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 712000, window: 1000000, percent: 71 }
  const atPrompt = await submit($)
  expect(atPrompt).toHaveLength(1)
  expect(atPrompt[0]).toMatch(new RegExp(HEAD + String.raw`context 71% \(712k of 1M\)`))
  w.context = { tokens: 905000, window: 1000000, percent: 90.5 }
  const afterTool = await toolCall($)
  expect(afterTool).toHaveLength(1)
  expect(afterTool[0]).toContain('context 91% (905k of 1M)')
})

test('the default note is facts only, one line, in the agreed form', async ($, on) => {
  const record = JSON.stringify({ oauthAccount: { accountUuid: '5a1e0000-0000-0000-0000-000000000009', emailAddress: 'user@example.com' } })
  const w = await setup($, on, { rateLimits: LIMITS(82, 40), files: { [`${HOME}/.claude.json`]: record } })
  w.context = { tokens: 712000, window: 1000000, percent: 71 }
  const [note] = await submit($)
  const s = NOW / 1000
  expect(note).toBe(
    `Brain Drain, user@example.com, read ${core.clock(s)}: context 71% (712k of 1M) · 5-hour window 82% used, resets ${core.resetClock(s + 7200, s)} (in 2 h) · ` +
      `week 40% used, resets ${core.dayClock(s + 4 * 86400)} (in 4 d; pace line 48%). ${notify.NOTE_SOURCE}`,
  )
  expect(note!.includes('\n')).toBe(false)
})

test('a threshold fires once, stays quiet while above, and re-arms after falling below', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(1)
  expect(await toolCall($)).toHaveLength(0)
  w.context = { tokens: 750000, window: 1000000, percent: 75 }
  expect(await submit($)).toHaveLength(0)
  // A compact: the fill is not known, so nothing fires; the context stages are cleared. With
  // these thresholds (70, 90) a figure of 20% is below them all, so no level fires, but the
  // compaction is told: the facts alone, once the new figure is known (MC-8006).
  w.context = { window: 1000000 }
  expect(await toolCall($)).toHaveLength(0)
  w.context = { tokens: 200000, window: 1000000, percent: 20 }
  const told = await toolCall($)
  expect(told).toHaveLength(1)
  expect(told[0]).toContain('context 20%')
  expect(told[0]!.includes('\n')).toBe(false)
  expect(await toolCall($)).toHaveLength(0)
  w.context = { tokens: 710000, window: 1000000, percent: 71 }
  expect(await toolCall($)).toHaveLength(1)
})

test('one note for several thresholds crossed at once; a five-hour reset re-arms that window', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 920000, window: 1000000, percent: 92 }
  w.rateLimits = LIMITS(96, 20)
  expect(await submit($)).toHaveLength(1)
  expect(await submit($)).toHaveLength(0)
  w.rateLimits = LIMITS(3, 20)
  expect(await submit($)).toHaveLength(0)
  w.rateLimits = LIMITS(81, 20)
  const [note] = await submit($)
  expect(note).toContain('5-hour window 81%')
})

test('weekly pace: fires above the pace line, re-arms as the line rises past the figure', async ($, on) => {
  const w = await setup($, on, { context: { tokens: 100000, window: 1000000, percent: 10 } })
  w.rateLimits = LIMITS(10, 50)
  expect(await submit($)).toHaveLength(1)
  // A day further into the week (three days to the reset) the line is at 62.1%: 50% is below it, so the threshold re-arms.
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 50, resetsAt: iso(NOW + 3 * 86400_000) }]
  expect(await submit($)).toHaveLength(0)
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 70, resetsAt: iso(NOW + 3 * 86400_000) }]
  const [note] = await submit($)
  expect(note).toMatch(/week 70% used, resets \w{3} \d{1,2} \w{3} \d\d:\d\d \(in 3 d; pace line 62%\)/)
})

test('subagents never get the note, and do not use up a threshold', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await toolCall($, 'agent-1')).toHaveLength(0)
  expect(await toolCall($)).toHaveLength(1)
})

test('on by default at the context stages 20, 30, 35 and 50, each with its words; /drain notify off stops it', async ($, on) => {
  const w = await setup($, on, { store: {}, context: { tokens: 150000, window: 1000000, percent: 15 } })
  // Below every stage, the session's first chance tells the facts alone (MC-8006).
  const opening = await submit($)
  expect(opening).toHaveLength(1)
  expect(opening[0]!.includes('\n')).toBe(false)
  w.context = { tokens: 210000, window: 1000000, percent: 21 }
  const [first] = await toolCall($)
  expect(first!.split('\n')).toEqual([
    expect.stringMatching(new RegExp(HEAD + String.raw`context 21% \(210k of 1M\) · 5-hour window 50% used, resets (\w{3} \d{1,2} \w{3} )?\d\d:\d\d \(in 2 h\) · week 20% used, resets .+ \(in 4 d; pace line 48%\)\. ` + SRC + '$')),
    'Set ahead of time for this level: For information: carry on.',
  ])
  const seen: string[] = []
  const words: Record<string, string> = {}
  for (const pct of [25, 30, 33, 35, 49, 50, 69, 70, 89, 90, 95]) {
    w.context = { tokens: pct * 10000, window: 1000000, percent: pct }
    const notes = await toolCall($)
    if (notes.length > 0) {
      seen.push(String(pct))
      words[pct] = notes[0]!.split('\n')[1]!.slice(P.length)
    }
  }
  expect(seen).toEqual(['30', '35', '50'])
  expect(words[30]).toBe('Wind down: finish the piece in hand, commit it, and start nothing new.')
  expect(words[35]).toMatch(/^Consider closing: finish the piece in hand and close the session, unless it clearly makes sense to go on\.$/)
  expect(words[50]).toMatch(/^Close now: finish the piece in hand, commit it, write a summary/)
  // The 5-hour and weekly thresholds are off unless turned on.
  w.context = { tokens: 960000, window: 1000000, percent: 96 }
  w.rateLimits = LIMITS(97, 99)
  expect(await submit($)).toHaveLength(0)
  await $.command.run(CMD('notify off'))
  w.sid = 'ffffffff-0000-0000-0000-000000000000'
  expect(await submit($)).toHaveLength(0)
  expect((w.store.get('prefs') as { notify: unknown }).notify).toEqual({ on: false, v: 2 })
})

test('after a compaction the first figure is told again, and each stage fires again as it climbs', async ($, on) => {
  const w = await setup($, on, { store: {} })
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  expect(await submit($)).toHaveLength(1)
  expect(await toolCall($)).toHaveLength(0)
  // Compacted: not known until the next reply. Nothing is said then.
  w.context = { window: 1000000 }
  expect(await submit($)).toHaveLength(0)
  // The first figure after it sits above 20%: it is told, though 20 had fired before.
  w.context = { tokens: 240000, window: 1000000, percent: 24 }
  const [again] = await toolCall($)
  expect(again).toContain('context 24%')
  w.context = { tokens: 310000, window: 1000000, percent: 31 }
  expect(await toolCall($)).toHaveLength(1)
  // A compaction seen only as a drop (never unknown at a hook) re-arms the stages it fell below,
  // and is told at once, the facts alone, though 12% is below every stage (MC-8006).
  w.context = { tokens: 120000, window: 1000000, percent: 12 }
  const [dropped] = await toolCall($)
  expect(dropped).toContain('context 12%')
  expect(dropped!.includes('\n')).toBe(false)
  w.context = { tokens: 210000, window: 1000000, percent: 21 }
  expect(await toolCall($)).toHaveLength(1)
})

test('a 0.2.1 block never touched takes the new defaults; a /drain change stores only what the user set', async ($, on) => {
  const w = await setup($, on, { store: LEGACY })
  w.context = { tokens: 210000, window: 1000000, percent: 21 }
  expect(await submit($)).toHaveLength(1)
  await $.command.run(CMD('agents on'))
  expect((w.store.get('prefs') as Record<string, unknown>).notify).toBeUndefined()
  expect((w.store.get('prefs') as Record<string, unknown>).agents).toBe(true)
  await $.command.run(CMD('notify 5h 80'))
  expect((w.store.get('prefs') as Record<string, unknown>).notify).toEqual({ fiveHour: [80], v: 2 })
  const shown = ((await $.command.run(CMD('notify'))) as { text: string }).text
  expect(shown).toContain('Self-notice on')
  expect(shown).toContain('context  20%, 30%, 35%, 50%')
  expect(shown).toContain('5h       80%')
})

test('a compaction clears the context stages however the next figure arrives', async ($, on) => {
  on('session.compact', () => ({ messages: SUMMARY }))
  const w = await setup($, on, { store: {} })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await toolCall($)).toHaveLength(1)
  // Auto-compacted mid-turn: no hook sees the figure unknown; the next one already reads 33%.
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  w.context = { tokens: 330000, window: 1000000, percent: 33 }
  const [after] = await toolCall($)
  expect(after).toContain('context 33%')
  // A precompute installs nothing, and a subagent's compaction is its own: neither clears.
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: SUMMARY })
  expect(await toolCall($)).toHaveLength(0)
})

test('where the guard skips session.compact, the fall in the context figure clears the stages (MC-7602)', async ($, on) => {
  // No session.compact runs here: as on a machine with managed settings, where the
  // built-in guard passes over a user's hooks on that event.
  const w = await setup($, on, { store: {} })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await toolCall($)).toHaveLength(1)
  // Auto-compacted mid-turn; the next figure already reads 33%. The 20 and 30 notes went
  // into the summary, so the first figure after it is told again.
  w.context = { tokens: 330000, window: 1000000, percent: 33 }
  const [after] = await toolCall($)
  expect(after).toContain('context 33%')
  expect(after!.split('\n')[1]).toBe(P + 'Wind down: finish the piece in hand, commit it, and start nothing new.')
  // Told once: the same figure, and a climb to 34%, say nothing more.
  expect(await toolCall($)).toHaveLength(0)
  w.context = { tokens: 340000, window: 1000000, percent: 34 }
  expect(await submit($)).toHaveLength(0)
  // Each stage fires again as it climbs.
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  expect(await toolCall($)).toHaveLength(1)
})

test('a small fall (earlier thinking dropped from the request) is no compaction', async ($, on) => {
  const w = await setup($, on, { store: {} })
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  expect(await toolCall($)).toHaveLength(1)
  w.context = { tokens: 310000, window: 1000000, percent: 31 }
  expect(await toolCall($)).toHaveLength(0)
  // A fall of 40% that is under 20k tokens is not one either.
  expect(notify.contextDropped(30000, 15000)).toBe(false)
  expect(notify.contextDropped(50000, 30000)).toBe(true)
  expect(notify.contextDropped(undefined, 30000)).toBe(false)
  expect(notify.contextDropped(300000, undefined)).toBe(false)
})

test('with the session.compact hook running too, the compaction is told once', async ($, on) => {
  on('session.compact', () => ({ messages: SUMMARY }))
  const w = await setup($, on, { store: {} })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await toolCall($)).toHaveLength(1)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  w.context = { tokens: 330000, window: 1000000, percent: 33 }
  expect(await toolCall($)).toHaveLength(1)
  expect(await toolCall($)).toHaveLength(0)
  expect(await submit($)).toHaveLength(0)
})

test('a block this version stored is never read as the 0.2.1 one, even with the same values', async ($, on) => {
  const same = { prefs: { ...PREFS, notify: { on: false, context: [70, 90], fiveHour: [80, 95], week: true, margin: 5, text: {}, v: 2 } } }
  const w = await setup($, on, { store: same })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(0)
  expect(notify.chosen(same.prefs.notify)).toEqual(same.prefs.notify)
})

test('a 0.2.1 block the user changed is kept as they left it', async ($, on) => {
  const kept = { prefs: { ...PREFS, notify: { on: false, context: [70, 90], fiveHour: [80, 95], week: false, margin: 5, text: {} } } }
  const w = await setup($, on, { store: kept })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(0)
  expect(notify.chosen(kept.prefs.notify)).toEqual(kept.prefs.notify)
  expect(notify.chosen(LEGACY.prefs.notify)).toBeUndefined()
  expect(notify.chosen({ ...LEGACY.prefs.notify, text: { 'context:70': 'stop' } })).toBeDefined()
  expect(notify.sanitize(undefined)).toEqual(notify.DEFAULT_NOTIFY)
})

test('the user\'s own text follows the facts, for the threshold that fired', async ($, on) => {
  const w = await setup($, on)
  const r = (await $.command.run(CMD('notify text context 70 "stop and write state"'))) as { text: string }
  expect(r.text).toContain('stop and write state')
  await $.command.run(CMD('notify text context 90 "never shown here"'))
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  const [note] = await submit($)
  expect(note!.split('\n')).toEqual([expect.stringMatching(new RegExp(HEAD + 'context 72%')), P + 'stop and write state'])
})

test('commands set the thresholds, and /drain notify shows them', async ($, on) => {
  const w = await setup($, on)
  await $.command.run(CMD('notify context 35 30'))
  await $.command.run(CMD('notify 5h 80'))
  await $.command.run(CMD('notify week off'))
  const shown = ((await $.command.run(CMD('notify'))) as { text: string }).text
  expect(shown).toContain('context  30%, 35%')
  expect(shown).toContain('5h       80%')
  expect(shown).toContain('week     off')
  w.context = { tokens: 320000, window: 1000000, percent: 32 }
  const [note] = await submit($)
  expect(note).toContain('context 32%')
  expect((w.store.get('prefs') as { notify: { context: number[] } }).notify.context).toEqual([30, 35])
  const help = ((await $.command.run(CMD('help'))) as { text: string }).text
  expect(help).toContain('/drain notify on|off')
})

test('BRAIN_DRAIN_NOTIFY turns it on and replaces the saved thresholds for the run', async ($, on) => {
  const env = JSON.stringify({ context: [30, 35], '5h': [80], week: false, text: { 'context:35': 'stop', '5h:80': 'start nothing new' } })
  const w = await setup($, on, { store: {}, env: { BRAIN_DRAIN_NOTIFY: env } })
  w.context = { tokens: 310000, window: 1000000, percent: 31 }
  w.rateLimits = LIMITS(50, 99)
  const [first] = await submit($)
  expect(first).toContain('context 31%')
  // The run's words are for 35 and 5h 80 only: 30 keeps its default words.
  expect(first!.split('\n').slice(1)).toEqual([P + 'Wind down: finish the piece in hand, commit it, and start nothing new.'])
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  w.rateLimits = LIMITS(85, 99)
  const [second] = await toolCall($)
  expect(second!.split('\n').slice(1)).toEqual([P + 'stop', P + 'start nothing new'])
  // The saved prefs are left as they were.
  expect(w.store.get('prefs')).toBeUndefined()
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('BRAIN_DRAIN_NOTIFY overrides')
})

test('a malformed BRAIN_DRAIN_NOTIFY is ignored and said so', async ($, on) => {
  const w = await setup($, on, { store: {}, env: { BRAIN_DRAIN_NOTIFY: '{"context": "lots", "on": false}' } })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  // The saved settings stand: here the defaults, so the stages fire.
  expect(await submit($)).toHaveLength(1)
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('"context" must be a list')
})

test('a claude -p run writes no file in the gauge folders but does get the note', async ($, on) => {
  const w = await setup($, on, { store: {}, env: { BRAIN_DRAIN_NOTIFY: '{"context":[30]}' } }, false)
  w.context = { tokens: 310000, window: 1000000, percent: 31 }
  expect(await toolCall($)).toHaveLength(1)
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge`)).toBeUndefined()
  // Only the headless folder holds its file (MC-8152), no gauge folder.
  expect([...w.files.keys()].filter(k => k.endsWith(`${SID}.json`) && !k.startsWith(`${HOME}/.claude/fuel-gauge-mod/headless/`))).toEqual([])
})

test('a /clear starts the fired set again', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(1)
  w.sid = 'ffffffff-0000-0000-0000-000000000000'
  expect(await submit($)).toHaveLength(1)
})

// Answers the setup question with `answer`, and counts how often it was asked.
function answering(on: any, answer: string) {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($: unknown, e: { questions: { question: string; options: { label: string }[] }[] }) => {
    const q = e.questions[0]!
    asked.push(`${q.question} [${q.options.map(o => o.label).join(' | ')}]`)
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  return asked
}

test('setting up asks once whether to turn the notice on, offering 20, 30, 35 and 50', async ($, on) => {
  const asked = answering(on, 'On at 20, 30, 35, 50%')
  const w = await setup($, on, { store: LEGACY })
  await settle()
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('[On at 20, 30, 35, 50% | Off]')
  expect((w.store.get('prefs') as { notify: unknown }).notify).toEqual({ on: true, v: 2 })
  expect(w.toasts.at(-1)).toContain('on at 20, 30, 35 and 50%')
  // A new session, a reload: not asked again.
  await start($)
  await settle()
  expect(asked).toHaveLength(1)
})

test('the setup question: Off turns it off; typed levels replace the stages', async ($, on) => {
  const asked = answering(on, 'Off')
  const w = await setup($, on, { store: {} })
  await settle()
  expect(asked).toHaveLength(1)
  expect((w.store.get('prefs') as { notify: unknown }).notify).toEqual({ on: false, v: 2 })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(0)
  expect(notify.levelsFrom('25, 40 and 60%')).toEqual([25, 40, 60])
  expect(notify.levelsFrom('sure')).toBeUndefined()
  expect(notify.levelsFrom('25 140')).toBeUndefined()
})

test('the setup question with levels typed under Other', async ($, on) => {
  answering(on, '25 40')
  const w = await setup($, on, { store: {} })
  await settle()
  expect((w.store.get('prefs') as { notify: unknown }).notify).toEqual({ on: true, context: [25, 40], v: 2 })
})

test('not asked: a user who chose notice settings in 0.2.1, a run its launcher configured, a -p run', async ($, on) => {
  const asked = answering(on, 'Off')
  const w = await setup($, on, { store: ON })
  await settle()
  expect(asked).toHaveLength(0)
  expect((w.store.get('prefs') as { notify: unknown }).notify).toEqual(ON.prefs.notify)
  w.store.clear()
  w.store.set('prefs', LEGACY.prefs)
  await start($, false)
  await settle()
  expect(asked).toHaveLength(0)
  expect(w.store.has('notifyAsked')).toBe(false)
})

test('not asked when BRAIN_DRAIN_NOTIFY is set', async ($, on) => {
  const asked = answering(on, 'Off')
  await setup($, on, { store: {}, env: { BRAIN_DRAIN_NOTIFY: '{"context":[48]}' } })
  await settle()
  expect(asked).toHaveLength(0)
})

test('a stage\'s default words can be replaced or silenced', async ($, on) => {
  answering(on, 'On at 20, 30, 35, 50%')
  const w = await setup($, on, { store: {} })
  await settle()
  await $.command.run(CMD('notify text context 35 "wrap up"'))
  await $.command.run(CMD('notify text context 20'))
  expect((w.store.get('prefs') as { notify: { text: unknown } }).notify.text).toEqual({ 'context:35': 'wrap up', 'context:20': '' })
  w.context = { tokens: 210000, window: 1000000, percent: 21 }
  expect((await submit($))[0]!.includes('\n')).toBe(false)
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  expect((await submit($))[0]!.split('\n').slice(1)).toEqual([P + 'wrap up'])
})

test('a stray prompt typed into the setup question sets no levels', async ($, on) => {
  answering(on, 'fix ticket 42')
  const w = await setup($, on, { store: {} })
  await settle()
  expect((w.store.get('prefs') as { notify?: unknown } | undefined)?.notify).toBeUndefined()
  expect(w.toasts.at(-1)).toContain('read no levels')
  expect(notify.levelsFrom('25 40')).toEqual([25, 40])
})

test('a setup question that cannot be asked says the default stands', async ($, on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'no dialogs here' }))
  const w = await setup($, on, { store: {} })
  await settle()
  expect(w.store.has('notifyAsked')).toBe(true)
  expect(w.toasts.at(-1)).toContain('on at 20, 30, 35 and 50%')
})

test('a silenced top stage gives way to the next stage\'s words', () => {
  const n = notify.sanitize({ text: { 'context:35': '' } })
  const f = { context: { pct: 36, tokens: 360000, window: 1000000 } }
  expect(notify.noticeText(f, n, ['context:30', 'context:35'], 0).split('\n').slice(1)).toEqual([P + 'Wind down: finish the piece in hand, commit it, and start nothing new.'])
  expect(notify.noticeText(f, n, ['context:35'], 0).includes('\n')).toBe(false)
})

test('pace line and env parsing', () => {
  const now = 1_000_000
  expect(notify.paceLine(now + 7 * 86400, now, 5)).toBe(5)
  expect(notify.paceLine(now, now, 0)).toBe(100)
  expect(notify.parseEnv('off').value).toEqual({ on: false })
  expect(notify.parseEnv('{"on":false,"5h":[80]}').value).toEqual({ on: false, fiveHour: [80] })
  expect(notify.parseEnv('{"weekly":true}').error).toContain('unknown key')
  expect(notify.parseEnv(undefined)).toEqual({})
  expect(notify.parseEnv('{"refresh":15}').value).toEqual({ on: true, refresh: 15 })
  expect(notify.parseEnv('{"refresh":0}').value).toEqual({ on: true, refresh: 0 })
  expect(notify.parseEnv('{"refresh":-1}').error).toContain('"refresh" must be minutes')
  expect(notify.parseEnv('{"refresh":"soon"}').error).toContain('"refresh" must be minutes')
  expect(notify.parseEnv('{"refresh":2000}').error).toContain('"refresh" must be minutes')
  expect(notify.sanitize({ refresh: 'soon' }).refresh).toBe(30)
  expect(notify.sanitize({ refresh: 0 }).refresh).toBe(0)
})

// ---------------------------------------------------------------- the facts told without a threshold (MC-8006)

const RECORD = (email: string, uuid: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } })
const ONE = RECORD('one@example.com', '11111111-aaaa-0000-0000-000000000001')
const TWO = RECORD('two@example.com', '22222222-bbbb-0000-0000-000000000002')

test('the note names the account by email, else by the start of its uuid, else says it is not certain', async ($, on) => {
  expect(core.accountLabel({ uuid: 'abcdef12-3456', email: 'a@example.com', source: 'folder' })).toBe('a@example.com')
  expect(core.accountLabel({ uuid: 'abcdef12-3456', source: 'session' })).toBe('account abcdef12')
  expect(core.accountLabel(undefined)).toBe('account not certain')
  expect(core.accountLabel('changed')).toBe('account not certain')
  // A host that hands over only the account's uuid.
  await setup($, on, { env: { CLAUDE_CODE_ACCOUNT_UUID: '9f3c1a7e-0000-0000-0000-000000000003' } })
  const [note] = await submit($)
  expect(note).toMatch(/^Brain Drain, account 9f3c1a7e, read \d\d:\d\d: context 30%/)
})

test('reset times: minutes left, hours and minutes, a weekday for the week; a window past its reset shows no figure', () => {
  expect(core.timeLeft(1000 + 46 * 60, 1000)).toBe('in 46 min')
  expect(core.timeLeft(1000 + 45 * 60 + 1, 1000)).toBe('in 46 min')
  expect(core.timeLeft(1000 + 65 * 60, 1000)).toBe('in 1 h 5 min')
  expect(core.timeLeft(1000 + 120 * 60, 1000)).toBe('in 2 h')
  expect(core.timeLeft(1000, 1000)).toBeUndefined()
  expect(core.dayClock(new Date(2026, 10, 22, 8, 0).getTime() / 1000)).toBe('Sun 22 Nov 08:00')
  const s = 1_800_000_000
  const line = notify.factsLine({ fiveHour: { pct: 82, resetsAt: s - 60 }, week: { pct: 40, resetsAt: s + 86400 } }, notify.DEFAULT_NOTIFY, s, 'a@example.com')
  expect(line).toContain(`5-hour window reset at ${core.resetClock(s - 60, s)}, no new figure yet · week 40% used, resets ${core.resetClock(s + 86400, s)} (in 1 d; pace line`)
  expect(line).not.toContain('82%')
  expect(notify.factsLine({ week: { pct: 40, resetsAt: s - 1 } }, notify.DEFAULT_NOTIFY, s)).toContain(`week reset at ${core.resetClock(s - 1, s)}, no new figure yet`)
  expect(notify.factsLine({}, notify.DEFAULT_NOTIFY, s)).toMatch(/^Brain Drain, account not certain, read \d\d:\d\d: no figures yet$/)
})

test('the first chance in a session tells the facts alone, below every threshold, once; a /clear tells them again', async ($, on) => {
  const w = await setup($, on)
  const [first] = await submit($)
  expect(first).toMatch(new RegExp(HEAD + 'context 30%'))
  expect(first!.includes('\n')).toBe(false)
  expect(await toolCall($)).toHaveLength(0)
  expect(await submit($)).toHaveLength(0)
  w.clear('ffffffff-0000-0000-0000-000000000000')
  expect(await submit($)).toHaveLength(1)
  expect(await toolCall($)).toHaveLength(0)
  // A /resume in the same process keeps $.state but changes the id: told again too.
  w.sid = 'eeeeeeee-0000-0000-0000-000000000000'
  expect(await toolCall($)).toHaveLength(1)
})

test('a claude -p run is told the facts at its first tool call, below every threshold', async ($, on) => {
  await setup($, on, { store: {}, context: { tokens: 100000, window: 1000000, percent: 10 } }, false)
  const [note] = await toolCall($)
  expect(note).toMatch(new RegExp(HEAD + 'context 10%'))
  expect(await toolCall($)).toHaveLength(0)
})

test('a compaction is told though the context after it is below every stage', async ($, on) => {
  on('session.compact', () => ({ messages: SUMMARY }))
  const w = await setup($, on, { store: {}, context: { tokens: 150000, window: 1000000, percent: 15 } })
  expect(await submit($)).toHaveLength(1)
  expect(await toolCall($)).toHaveLength(0)
  // A small fall, so only the hook knows: told with the first figure after it.
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  w.context = { tokens: 140000, window: 1000000, percent: 14 }
  const [note] = await toolCall($)
  expect(note).toMatch(new RegExp(HEAD + 'context 14%'))
  expect(note!.includes('\n')).toBe(false)
  expect(await toolCall($)).toHaveLength(0)
})

test('the facts are told again 30 minutes after the last note, not sooner; any note restarts the wait', SLOW, async ($, on) => {
  const w = await setup($, on)
  expect(await submit($)).toHaveLength(1)
  await w.clock.advance(29 * 60_000)
  expect(await toolCall($)).toHaveLength(0)
  await w.clock.advance(60_000)
  const [again] = await toolCall($)
  expect(again).toMatch(new RegExp(HEAD + 'context 30%'))
  expect(await toolCall($)).toHaveLength(0)
  // A threshold's note ten minutes on counts as the last note.
  await w.clock.advance(10 * 60_000)
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await toolCall($)).toHaveLength(1)
  await w.clock.advance(25 * 60_000)
  expect(await submit($)).toHaveLength(0)
  await w.clock.advance(5 * 60_000)
  expect(await submit($)).toHaveLength(1)
})

test('refresh 0 turns the timed refresh off; /drain notify refresh sets it', SLOW, async ($, on) => {
  const w = await setup($, on, { env: { BRAIN_DRAIN_NOTIFY: '{"context":[70,90],"refresh":0}' } })
  expect(await submit($)).toHaveLength(1)
  await w.clock.advance(31 * 60_000)
  expect(await toolCall($)).toHaveLength(0)
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('refresh  off')
  expect(((await $.command.run(CMD('notify refresh 10'))) as { text: string }).text).toContain('10 min after the last note')
  expect((w.store.get('prefs') as { notify: unknown }).notify).toEqual({ ...ON.prefs.notify, refresh: 10, v: 2 })
  expect(((await $.command.run(CMD('notify refresh soon'))) as { text: string }).text).toContain('Give the minutes')
  await $.command.run(CMD('notify refresh off'))
  expect((w.store.get('prefs') as { notify: { refresh: number } }).notify.refresh).toBe(0)
})

test('when the five-hour window starts again the facts are told, once its new reset is known', async ($, on) => {
  const week = { kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 4 * 86400_000) }
  const w = await setup($, on, { rateLimits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: iso(NOW + 60_000) }, week] })
  expect(await submit($)).toHaveLength(1)
  await w.clock.advance(2 * 60_000)
  // Past the reset, the engine still holds the old window's figure: no note on it, and the line shows none.
  expect(await toolCall($)).toHaveLength(0)
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('5-hour window reset at')
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 1, resetsAt: iso(NOW + 60_000 + 5 * 3600_000) }, week]
  const [note] = await toolCall($)
  expect(note).toContain('5-hour window 1% used, resets')
  expect(await toolCall($)).toHaveLength(0)
})

test('a change of login is told at once, and the note no longer names an account', async ($, on) => {
  const w = await setup($, on, { files: { [`${HOME}/.claude.json`]: ONE } })
  const [first] = await submit($)
  expect(first).toMatch(/^Brain Drain, one@example\.com, read/)
  w.files.set(`${HOME}/.claude.json`, TWO)
  await w.clock.advance(61_000)
  const [changed] = await toolCall($)
  expect(changed).toMatch(new RegExp(HEAD + 'context 30%'))
  expect(await toolCall($)).toHaveLength(0)
})

test('a note on a dropped prompt is not counted as told', async ($, on) => {
  let drop = true
  world(on, { now: NOW, context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: LIMITS(50, 20), store: ON })
  on('prompt.submit', ($2: unknown, e: { text: string; context?: readonly string[] }) => (drop ? { drop: 'held back' } : { text: e.text, context: e.context }))
  await start($)
  await Promise.resolve($.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })).catch(() => undefined)
  drop = false
  const [note] = await submit($)
  expect(note).toMatch(new RegExp(HEAD + 'context 30%'))
})

// ---------------------------------------------------------------- the shared wording and the labels file (MC-8006)

const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime() / 1000

test('time left from a day on reads in days and hours; under a day as before', () => {
  expect(core.timeLeft(1000 + 23 * 3600 + 59 * 60, 1000)).toBe('in 23 h 59 min')
  expect(core.timeLeft(1000 + 86400, 1000)).toBe('in 1 d')
  expect(core.timeLeft(1000 + 86400 + 59 * 60, 1000)).toBe('in 1 d')
  expect(core.timeLeft(1000 + 5 * 86400 + 8 * 3600 + 19 * 60, 1000)).toBe('in 5 d 8 h')
  expect(core.timeLeft(1000 + 2 * 86400 + 3600, 1000)).toBe('in 2 d 1 h')
})

test('a reset today names the clock time; a reset on another day, after midnight too, names weekday and date', () => {
  const evening = local(2026, 10, 16, 20, 0)
  expect(core.resetClock(local(2026, 10, 16, 22, 0), evening)).toBe('22:00')
  expect(core.resetClock(local(2026, 10, 17, 0, 0), evening)).toBe('Tue 17 Nov 00:00')
  expect(core.resetClock(local(2026, 10, 22, 8, 0), evening)).toBe('Sun 22 Nov 08:00')
  expect(core.resetClock(local(2026, 10, 15, 23, 50), local(2026, 10, 16, 0, 5))).toBe('Sun 15 Nov 23:50')
})

test('the note in the agreed wording: "used", the clock time, how long until it, and a date only when not today', () => {
  const f = (now: number, five: number, week: number) =>
    notify.factsLine({ context: { pct: 5.6, tokens: 56000, window: 1000000 }, fiveHour: { pct: 86, resetsAt: five }, week: { pct: 37, resetsAt: week } }, notify.DEFAULT_NOTIFY, now, 'work@')
  const weekAt = local(2026, 10, 22, 8, 0)
  // Today: a five-hour reset later this evening.
  const evening = local(2026, 10, 16, 20, 0)
  const pace1 = Math.round(notify.paceLine(weekAt, evening, 5))
  expect(f(evening, local(2026, 10, 16, 22, 0), weekAt)).toBe(
    `Brain Drain, work@, read 20:00: context 6% (56k of 1M) · 5-hour window 86% used, resets 22:00 (in 2 h) · week 37% used, resets Sun 22 Nov 08:00 (in 5 d 12 h; pace line ${pace1}%)`,
  )
  // Not today: the five-hour reset just after midnight gets its date too.
  const late = local(2026, 10, 16, 23, 41)
  const pace2 = Math.round(notify.paceLine(weekAt, late, 5))
  expect(f(late, local(2026, 10, 17, 0, 0), weekAt)).toBe(
    `Brain Drain, work@, read 23:41: context 6% (56k of 1M) · 5-hour window 86% used, resets Tue 17 Nov 00:00 (in 19 min) · week 37% used, resets Sun 22 Nov 08:00 (in 5 d 8 h; pace line ${pace2}%)`,
  )
  // On the day of the weekly reset, the week names the clock time alone.
  const sunday = local(2026, 10, 22, 6, 0)
  expect(f(sunday, local(2026, 10, 22, 9, 0), weekAt)).toContain(`week 37% used, resets 08:00 (in 2 h; pace line`)
  // A reset passed: the same rule for its time.
  const justAfter = local(2026, 10, 17, 0, 5)
  expect(notify.factsLine({ fiveHour: { pct: 86, resetsAt: local(2026, 10, 16, 23, 50) } }, notify.DEFAULT_NOTIFY, justAfter)).toContain(
    '5-hour window reset at Mon 16 Nov 23:50, no new figure yet',
  )
  expect(notify.factsLine({ fiveHour: { pct: 86, resetsAt: local(2026, 10, 17, 0, 1) } }, notify.DEFAULT_NOTIFY, justAfter)).toContain(
    '5-hour window reset at 00:01, no new figure yet',
  )
  // No reset known: the figure alone.
  expect(notify.factsLine({ fiveHour: { pct: 86 }, week: { pct: 37 } }, notify.DEFAULT_NOTIFY, late)).toContain('5-hour window 86% used · week 37% used')
})

const LABELS_PATH = `${HOME}/.claude/fuel-gauge-mod/labels.json`
const ONE_UUID = '11111111-aaaa-0000-0000-000000000001'
const TWO_UUID = '22222222-bbbb-0000-0000-000000000002'

test('a label for the session\'s own account names it in the note; a label for another account is ignored', async ($, on) => {
  const w = await setup($, on, { files: { [`${HOME}/.claude.json`]: ONE, [LABELS_PATH]: JSON.stringify({ [ONE_UUID]: 'one@', [TWO_UUID]: 'two@' }) } })
  const [note] = await submit($)
  expect(note).toMatch(/^Brain Drain, one@, read \d\d:\d\d: context 30%/)
  // The session files keep the email.
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge`)).toMatchObject({ account_email: 'one@example.com' })
})

test('a label only for another account leaves the email', async ($, on) => {
  await setup($, on, { files: { [`${HOME}/.claude.json`]: ONE, [LABELS_PATH]: JSON.stringify({ [TWO_UUID]: 'two@' }) } })
  const [note] = await submit($)
  expect(note).toMatch(/^Brain Drain, one@example\.com, read/)
})

test('the labels file sits under the home folder, whatever CLAUDE_CONFIG_DIR says', async ($, on) => {
  await setup($, on, {
    env: { CLAUDE_CONFIG_DIR: '/h/.claude-work' },
    files: { '/h/.claude-work/.claude.json': ONE, '/h/.claude-work/fuel-gauge-mod/labels.json': JSON.stringify({ [ONE_UUID]: 'wrong@' }), [LABELS_PATH]: JSON.stringify({ [ONE_UUID]: 'one@' }) },
  })
  const [note] = await submit($)
  expect(note).toMatch(/^Brain Drain, one@, read/)
})

test('a bad labels file means no labels, silently', async ($, on) => {
  const w = await setup($, on, { files: { [`${HOME}/.claude.json`]: ONE, [LABELS_PATH]: '{ not json' } })
  const [note] = await submit($)
  expect(note).toMatch(/^Brain Drain, one@example\.com, read/)
  expect(w.toasts).toEqual([])
})

test('the labels file is read again at most once a minute', async ($, on) => {
  const w = await setup($, on, { files: { [`${HOME}/.claude.json`]: ONE } })
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('The note reads, now: Brain Drain, one@example.com,')
  w.files.set(LABELS_PATH, JSON.stringify({ [ONE_UUID]: 'one@' }))
  await w.clock.advance(30_000)
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('Brain Drain, one@example.com,')
  await w.clock.advance(31_000)
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('Brain Drain, one@,')
})

test('a label never overrides a change of login: the note says account not certain', async ($, on) => {
  const w = await setup($, on, { files: { [`${HOME}/.claude.json`]: ONE, [LABELS_PATH]: JSON.stringify({ [ONE_UUID]: 'one@', [TWO_UUID]: 'two@' }) } })
  const [first] = await submit($)
  expect(first).toMatch(/^Brain Drain, one@, read/)
  w.files.set(`${HOME}/.claude.json`, TWO)
  await w.clock.advance(61_000)
  const [changed] = await toolCall($)
  expect(changed).toMatch(new RegExp(HEAD + 'context 30%'))
  expect(changed).not.toContain('two@')
})
