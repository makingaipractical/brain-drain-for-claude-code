import { expect, test } from 'claude-code/testing'
import * as notify from '../hooks/notify.ts'
import { HOME, SID, sessionFile, start, world } from './world.ts'
import type { WorldOptions } from './world.ts'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
// Four days to the weekly reset: three days gone, so the pace line is 3/7 x 100 + 5 = 47.9%.
const LIMITS = (five: number, week: number) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: iso(NOW + 2 * 3600_000) },
  { kind: 'seven_day', percentUsed: week, resetsAt: iso(NOW + 4 * 86400_000) },
]
const ON = { prefs: { style: 'bars', place: 'below', warnSeconds: 60, sound: false, agents: false, notify: { ...notify.DEFAULT_NOTIFY, on: true } } }
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
  // A compact: the fill is not known, so nothing fires and nothing re-arms.
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

test('off by default: no note until /drain notify on', async ($, on) => {
  const w = await setup($, on, { store: {} })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(0)
  await $.command.run(CMD('notify on'))
  expect(await submit($)).toHaveLength(1)
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
  expect(first!.includes('\n')).toBe(false)
  w.context = { tokens: 360000, window: 1000000, percent: 36 }
  w.rateLimits = LIMITS(85, 99)
  const [second] = await toolCall($)
  expect(second!.split('\n').slice(1)).toEqual(['stop', 'start nothing new'])
  // The saved prefs are left as they were.
  expect(w.store.get('prefs')).toBeUndefined()
  expect(((await $.command.run(CMD('notify'))) as { text: string }).text).toContain('BRAIN_DRAIN_NOTIFY overrides')
})

test('a malformed BRAIN_DRAIN_NOTIFY is ignored and said so', async ($, on) => {
  const w = await setup($, on, { store: {}, env: { BRAIN_DRAIN_NOTIFY: '{"context": "lots"}' } })
  w.context = { tokens: 720000, window: 1000000, percent: 72 }
  expect(await submit($)).toHaveLength(0)
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

test('pace line and env parsing', () => {
  const now = 1_000_000
  expect(notify.paceLine(now + 7 * 86400, now, 5)).toBe(5)
  expect(notify.paceLine(now, now, 0)).toBe(100)
  expect(notify.parseEnv('off').value).toEqual({ on: false })
  expect(notify.parseEnv('{"on":false,"5h":[80]}').value).toEqual({ on: false, fiveHour: [80] })
  expect(notify.parseEnv('{"weekly":true}').error).toContain('unknown key')
  expect(notify.parseEnv(undefined)).toEqual({})
})
