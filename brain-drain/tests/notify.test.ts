import { expect, test } from 'claude-code/testing'
import * as notify from '../hooks/notify.ts'
import { HOME, SID, sessionFile, settle, start, world } from './world.ts'
import type { WorldOptions } from './world.ts'

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
  expect(atPrompt[0]).toMatch(/^Brain Drain: context 71% \(712k of 1M\)/)
  w.context = { tokens: 905000, window: 1000000, percent: 90.5 }
  const afterTool = await toolCall($)
  expect(afterTool).toHaveLength(1)
  expect(afterTool[0]).toContain('context 91% (905k of 1M)')
})

test('the default note is facts only, one line, in the agreed form', async ($, on) => {
  const w = await setup($, on, { rateLimits: LIMITS(82, 40) })
  w.context = { tokens: 712000, window: 1000000, percent: 71 }
  const [note] = await submit($)
  expect(note).toMatch(/^Brain Drain: context 71% \(712k of 1M\) · 5-hour window 82%, resets \d\d:\d\d · week 40% \(pace line 48%\)$/)
  expect(note!.includes('\n')).toBe(false)
})

test('a threshold fires once, stays quiet while above, and re-arms after falling below', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(1)
  expect(await toolCall($)).toHaveLength(0)
  w.context = { tokens: 750000, window: 1000000, percent: 75 }
  expect(await submit($)).toHaveLength(0)
  // A compact: the fill is not known, so nothing fires; the context stages are cleared, and with
  // these thresholds (70, 90) a figure of 20% is below them all, so nothing fires there either.
  w.context = { window: 1000000 }
  expect(await toolCall($)).toHaveLength(0)
  w.context = { tokens: 200000, window: 1000000, percent: 20 }
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
  expect(note).toContain('week 70% (pace line 62%)')
})

test('subagents never get the note, and do not use up a threshold', async ($, on) => {
  const w = await setup($, on)
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await toolCall($, 'agent-1')).toHaveLength(0)
  expect(await toolCall($)).toHaveLength(1)
})

test('on by default at the context stages 20, 30, 35 and 50, each with its words; /drain notify off stops it', async ($, on) => {
  const w = await setup($, on, { store: {}, context: { tokens: 150000, window: 1000000, percent: 15 } })
  expect(await submit($)).toHaveLength(0)
  w.context = { tokens: 210000, window: 1000000, percent: 21 }
  const [first] = await toolCall($)
  expect(first!.split('\n')).toEqual([
    expect.stringMatching(/^Brain Drain: context 21% \(210k of 1M\) · 5-hour window 50%, resets \d\d:\d\d · week 20% \(pace line 48%\)$/),
    'For information: carry on.',
  ])
  const seen: string[] = []
  const words: Record<string, string> = {}
  for (const pct of [25, 30, 33, 35, 49, 50, 69, 70, 89, 90, 95]) {
    w.context = { tokens: pct * 10000, window: 1000000, percent: pct }
    const notes = await toolCall($)
    if (notes.length > 0) {
      seen.push(String(pct))
      words[pct] = notes[0]!.split('\n')[1]!
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
  // A compaction seen only as a drop (never unknown at a hook) re-arms the stages it fell below.
  w.context = { tokens: 120000, window: 1000000, percent: 12 }
  expect(await toolCall($)).toHaveLength(0)
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
  expect(note!.split('\n')).toEqual([expect.stringMatching(/^Brain Drain: context 72%/), 'stop and write state'])
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
  expect(first!.split('\n').slice(1)).toEqual(['Wind down: finish the piece in hand, commit it, and start nothing new.'])
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  w.rateLimits = LIMITS(85, 99)
  const [second] = await toolCall($)
  expect(second!.split('\n').slice(1)).toEqual(['stop', 'start nothing new'])
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

test('a claude -p run writes no session file but does get the note', async ($, on) => {
  const w = await setup($, on, { store: {}, env: { BRAIN_DRAIN_NOTIFY: '{"context":[30]}' } }, false)
  w.context = { tokens: 310000, window: 1000000, percent: 31 }
  expect(await toolCall($)).toHaveLength(1)
  expect(sessionFile(w, `${HOME}/.claude/fuel-gauge`)).toBeUndefined()
  expect([...w.files.keys()].some(k => k.endsWith(`${SID}.json`))).toBe(false)
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
  expect((await submit($))[0]!.split('\n').slice(1)).toEqual(['wrap up'])
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
  expect(notify.noticeText(f, n, ['context:30', 'context:35'], 0).split('\n').slice(1)).toEqual(['Wind down: finish the piece in hand, commit it, and start nothing new.'])
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
})
