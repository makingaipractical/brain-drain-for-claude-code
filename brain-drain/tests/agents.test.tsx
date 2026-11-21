import { describe, expect, test } from 'claude-code/testing'
import * as agentBars from '../hooks/agents.ts'
import { cellWidth, plain } from '../hooks/core.ts'
import type { DrainAgent } from '../types'
import { settle, start, transcript, world } from './world.ts'

// One assistant record as Claude Code writes it: one per content block, each with the response's usage.
function rec(msg: string, block: number, cacheWrite: number, cacheRead: number, out: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant', isSidechain: true, requestId: `req_${msg}`, apiBlockIndex: block, effort: 'high',
    message: { id: `msg_${msg}`, model: 'claude-opus-5-5', role: 'assistant',
      usage: { input_tokens: 2, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: out } },
    ...extra,
  })
}
const USER = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })
const lines = (...l: string[]) => l.map(x => `${x}\n`).join('')

describe('counting', () => {
  test('a response written as several blocks counts once, and its last block\'s output wins', () => {
    const acc = agentBars.newAcc()
    agentBars.feed(acc, lines(
      USER,
      rec('A', 0, 1000, 5000, 7), rec('A', 1, 1000, 5000, 7), rec('A', 2, 1000, 5000, 385),
      rec('B', 0, 0, 6000, 10),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_S', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
    ))
    expect(acc.requests).toBe(2)
    expect(acc.output).toBe(395)
    expect(acc.tokens).toBe(2 + 1000 + 5000 + 385 + (2 + 6000 + 10))
    expect(acc.context).toBe(2 + 6000 + 10)
    expect(acc.model).toBe('claude-opus-5-5')
    expect(acc.effort).toBe('high')
  })

  test('a half-written last line waits for the next read, and a response split across reads still counts once', () => {
    const acc = agentBars.newAcc()
    const done = lines(rec('A', 0, 1000, 5000, 7))
    const rest = lines(rec('A', 1, 1000, 5000, 300), rec('B', 0, 0, 8000, 20))
    const file = done + rest
    const cut = done.length + 25
    agentBars.feed(acc, file.slice(0, cut))
    expect(acc.offset).toBe(done.length)
    expect(acc.requests).toBe(1)
    expect(acc.output).toBe(7)
    expect(acc.context).toBe(2 + 1000 + 5000 + 7)
    agentBars.feed(acc, file.slice(acc.offset))
    expect(acc.offset).toBe(file.length)
    expect(acc.requests).toBe(2)
    expect(acc.output).toBe(320)
    expect(acc.tokens).toBe(2 + 1000 + 5000 + 300 + (2 + 8000 + 20))
    expect(acc.context).toBe(2 + 8000 + 20)
  })

  test('the offset counts UTF-8 bytes, not characters', () => {
    expect(agentBars.utf8Bytes('aé€😀')).toBe(1 + 2 + 3 + 4)
    const acc = agentBars.newAcc()
    const text = lines(rec('A', 0, 10, 10, 1, { note: 'Größe 😀' }))
    agentBars.feed(acc, text)
    expect(acc.offset).toBe(text.length + 1 + 1 + 2) // ö and ß: one unit, two bytes; the emoji: two units, four bytes
    expect(acc.requests).toBe(1)
  })

  test('a read that lands mid-line skips to the next whole line', () => {
    const acc = { ...agentBars.newAcc(), offset: 40 }
    agentBars.feed(acc, `0, "output_tokens": 99}}}\n${rec('B', 0, 0, 100, 5)}\n`)
    expect(acc.requests).toBe(1)
    expect(acc.output).toBe(5)
  })

  test('the label is the meta\'s name, else its type, else the id', () => {
    expect(agentBars.labelFrom({ name: 'exec-hooks', agentType: 'opus-executor' }, 'x')).toBe('exec-hooks')
    expect(agentBars.labelFrom({ agentType: 'general-purpose' }, 'x')).toBe('general-purpose')
    expect(agentBars.labelFrom(undefined, 'a1b2')).toBe('a1b2')
  })
})

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const agent = (label: string, context: number, output: number, agoS: number, extra: Partial<DrainAgent> = {}): DrainAgent => ({
  id: `a${label}`, label, context, tokens: context * 10, output, requests: 10, model: 'claude-opus-5-5', effort: 'high', mtimeMs: NOW - agoS * 1000, ...extra,
})

describe('rows', () => {
  test('one row per agent showing what it holds and wrote, bars scaled to the largest, a guessed running state, one total line', () => {
    const text = agentBars.agentText([
      agent('rename-executor', 127_592, 11_676, 300, { effort: 'medium', tokens: 1_258_861 }),
      agent('agent-bars', 88_185, 3_329, 5, { tokens: 354_129 }),
    ], NOW)
    expect(text).toBe([
      '  agent-bars      ▰▰▰▰▰▰▰▱▱▱ holds  88k  wrote 3k   opus·high  running?',
      '  rename-executor ▰▰▰▰▰▰▰▰▰▰ held  128k  wrote 12k  opus·medium',
      '  1 running · 2 agents · 1.6M tokens processed, each re-read counted · 15k written · bars against the largest',
    ].join('\n'))
  })

  // MC-6284: a screenshot of 27 October 16:31, three opus-executor agents of one session, with
  // their transcripts' figures at 16:31:07. Each row is the agent's context (Claude Code said 157k
  // and 129k for the two finished ones), the total line the sum of every request.
  // MC-7035: the running one is a background agent Claude Code's own panel lists, so it has no row
  // here; its name and size go on the total line.
  test('the 27 October screenshot: finished agents get rows, the running background one folds into the total line', () => {
    const text = agentBars.agentText([
      agent('opus-executor', 155_788, 29_002, 600, { id: 'a08f', tokens: 3_544_545, status: 'completed' }),
      agent('opus-executor', 127_592, 40_147, 3000, { id: 'a52c', tokens: 2_992_824, status: 'completed' }),
      agent('opus-executor', 88_185, 8_010, 1, { id: 'a5ac', tokens: 923_572, status: 'running' }),
    ], NOW)
    expect(text).toBe([
      '  opus-executor ▰▰▰▰▰▰▰▰▰▰ held  156k  wrote 29k  opus·high  done',
      '  opus-executor ▰▰▰▰▰▰▰▰▱▱ held  128k  wrote 40k  opus·high  done',
      '  1 running (opus-executor holds 88k) · 2 done · 7.5M tokens processed, each re-read counted · 77k written · bars against the largest',
    ].join('\n'))
  })

  // MC-7035: rows only for what Claude Code's agent panel never shows.
  test('the panel lists running, pending, waiting and idle agents, foreground ones too (seen live, 6 November); never a workflow agent, never a finished one', () => {
    const inPanel = (extra: Partial<DrainAgent>, agoS = 600) => agentBars.inPanel(agent('x', 1, 1, agoS, extra), NOW)
    for (const status of ['running', 'pending', 'waiting', 'idle']) expect(inPanel({ status })).toBe(true)
    expect(inPanel({ status: 'completed' }, 1)).toBe(false)
    expect(inPanel({ finished: true }, 1)).toBe(false)
    expect(inPanel({ status: 'running', workflow: true })).toBe(false)
    expect(inPanel({ status: 'running', foreground: true })).toBe(true)
    // No engine word: the mod cannot tell, so the agent keeps its row.
    expect(inPanel({}, 1)).toBe(false)
  })

  test('a failed or stopped background agent folds for the panel\'s 30 seconds, then gets its row', () => {
    const inPanel = (status: string, agoS: number) => agentBars.inPanel(agent('x', 1, 1, agoS, { status }), NOW)
    expect(inPanel('failed', 10)).toBe(true)
    expect(inPanel('killed', 30)).toBe(true)
    expect(inPanel('failed', 31)).toBe(false)
    expect(inPanel('killed', 600)).toBe(false)
  })

  test('a workflow agent keeps its row while running; a foreground agent is folded like a background one', () => {
    const rows = agentBars.agentText([
      agent('wf-reader', 40_000, 2_000, 600, { status: 'running', workflow: true }),
      agent('fg-helper', 80_000, 5_000, 500, { status: 'running', foreground: true }),
    ], NOW).split('\n')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/wf-reader .*holds 40k .*running$/)
    expect(rows[1]).toMatch(/^ {2}2 running \(fg-helper holds 80k\) · /)
  })

  test('only running background agents: no rows, the total line names each with its size', () => {
    const rows = agentBars.agentText([
      agent('opus-executor', 226_000, 76_000, 2, { id: 'a1', status: 'running', tokens: 6_900_000 }),
      agent('Explore', 40_000, 3_000, 2, { id: 'a2', status: 'running', tokens: 400_000 }),
    ], NOW).split('\n')
    expect(rows).toEqual(['  2 running (opus-executor holds 226k, Explore 40k) · 7.3M tokens processed, each re-read counted · 79k written'])
  })

  test('many agents in the panel: three named, then +N; narrower, the first only; narrowest, the count alone', () => {
    const list = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((l, i) => agent(l, (5 - i) * 10_000, 100, 2, { id: l, status: 'running' }))
    const line = (cols?: number) => agentBars.agentRows(list, NOW, cols).map(plain).join('\n')
    expect(line()).toBe('  5 running (alpha holds 50k, beta 40k, gamma 30k, +2) · 1.5M tokens processed, each re-read counted · 500 written')
    expect(line(80)).toBe('  5 running (alpha holds 50k, +4) · 1.5M tokens processed · 500 written')
    expect(line(60)).toBe('  5 running (alpha holds 50k, +4) · 1.5M tokens processed')
    expect(line(30)).toBe('  5 running · 1.5M processed')
  })

  // A replay of a session of 2 November (four background opus-executors) while they ran.
  test('agents of one name in the panel give the name once', () => {
    const list = [589_000, 418_000, 271_000, 209_000].map((c, i) => agent('opus-executor', c, 1000, 2, { id: `a${i}`, status: 'running' }))
    expect(agentBars.agentRows(list, NOW).map(plain)).toEqual(['  4 running (opus-executor holds 589k, 418k, 271k, +1) · 14.9M tokens processed, each re-read counted · 4k written'])
  })

  // A running row's word and bar take the theme's success green, the word bold; a done
  // row's word, bar and size are faint; a failed word the warning colour; a stopped row
  // is plain ink with its word.
  test('running is green and bold, done grey, failed the warning colour; nothing is red', () => {
    const rows = agentBars.agentRows([
      agent('busy', 1000, 10, 600, { status: 'running', workflow: true }),
      agent('waits', 1000, 10, 600, { status: 'idle', workflow: true }),
      agent('broke', 1000, 10, 600, { status: 'failed' }),
      // Written last, so it sorts above the other ended rows and is not retired (DONE_ROWS).
      agent('ended', 1000, 10, 500, { status: 'completed' }),
      agent('halted', 1000, 10, 600, { status: 'killed' }),
    ], NOW)
    const row = (label: string) => rows.find(r => r[0]!.text.includes(label))!
    const last = (label: string) => row(label)[row(label).length - 1]!
    const fill = (label: string) => row(label).find(s => s.text.startsWith('▰'))!
    expect(last('ended')).toEqual({ text: 'done', dim: true })
    expect(fill('ended').color).toBeUndefined()
    expect(fill('ended').dim).toBe(true)
    expect(row('ended').find(s => s.text.trim() === '1k')!.dim).toBe(true)
    expect(last('busy')).toEqual({ text: 'running', color: 'success', bold: true })
    expect(fill('busy').color).toBe('success')
    expect(last('broke')).toEqual({ text: 'failed', color: 'warning' })
    expect(last('halted')).toEqual({ text: 'stopped' })
    expect(last('waits')).toEqual({ text: 'idle' })
    expect(fill('waits').color).toBeUndefined()
    // The figures stay at full ink on every row but a done one, the stopped one too.
    for (const l of ['busy', 'waits', 'broke', 'halted']) expect(row(l).find(s => s.text.trim() === '1k')!.dim).toBeUndefined()
    expect(row('ended').some(s => s.color === 'success')).toBe(false)
    expect(rows.flat().some(s => s.color === 'error')).toBe(false)
  })

  test('on the total line the running count is green and bold, the failed count the warning colour; done and the rest stay faint', () => {
    const rows = agentBars.agentRows([
      agent('busy', 1000, 10, 600, { status: 'running' }),
      agent('ended', 1000, 10, 600, { status: 'completed' }),
      agent('broke', 1000, 10, 600, { status: 'failed' }),
    ], NOW)
    const sum = rows[rows.length - 1]!
    expect(sum.find(s => s.text === '1 done')).toEqual({ text: '1 done', dim: true })
    expect(sum.find(s => s.text === '1 running')).toEqual({ text: '1 running', color: 'success', bold: true })
    expect(sum.find(s => s.text === '1 failed')).toEqual({ text: '1 failed', color: 'warning' })
    expect(sum.find(s => s.text === ' (busy holds 1k)')!.dim).toBe(true)
    expect(sum.map(s => s.text).join('')).toBe('  1 running (busy holds 1k) · 1 done · 1 failed · 30k tokens processed, each re-read counted · 30 written · bars against the largest')
  })

  test('the total line counts each state; agents with no word are covered by the full count', () => {
    const counts = (list: DrainAgent[]) => agentBars.stateCounts(list, NOW)
    expect(counts([agent('a', 1, 1, 600, { status: 'running' }), agent('b', 1, 1, 1)])).toBe('2 running')
    expect(counts([
      agent('a', 1, 1, 600, { status: 'failed' }), agent('b', 1, 1, 600, { status: 'killed' }),
      agent('c', 1, 1, 600, { finished: true }), agent('d', 1, 1, 600, { status: 'idle' }),
    ])).toBe('1 idle · 1 done · 1 failed · 1 stopped')
    expect(counts([agent('a', 1, 1, 600, { finished: true }), agent('wf', 1, 1, 600)])).toBe('1 done · 2 agents')
    expect(counts([agent('wf', 1, 1, 600)])).toBe('1 agent')
  })

  // MC-7035: a bar scaled to the largest agent on screen always looked full when one agent was alone.
  test('a lone row has no bar; two or more compare, and the total line says against what', () => {
    const one = agentBars.agentText([agent('solo', 226_000, 76_000, 600, { status: 'completed' })], NOW)
    expect(one).not.toMatch(/[▰▱]/)
    expect(one).toBe([
      '  solo held  226k  wrote 76k  opus·high  done',
      '  1 done · 2.3M tokens processed, each re-read counted · 76k written',
    ].join('\n'))
    // One row beside a folded agent is still a lone row.
    expect(agentBars.agentText([
      agent('solo', 226_000, 76_000, 600, { status: 'completed' }),
      agent('busy', 50_000, 1_000, 1, { status: 'running' }),
    ], NOW)).not.toMatch(/[▰▱]/)
  })

  test('a row stored before the context field existed draws as zero, not NaN', () => {
    const old = { ...agent('old', 0, 10, 600), context: undefined } as unknown as DrainAgent
    const text = agentBars.agentText([old], NOW)
    expect(text).toContain('held  0')
    expect(text).not.toContain('NaN')
  })

  test('the engine\'s own word beats the guess', () => {
    const rows = agentBars.agentRows([
      agent('busy', 1000, 10, 600, { status: 'running', workflow: true }),
      agent('done', 1000, 10, 1, { status: 'completed' }),
    ], NOW).map(r => r.map(s => s.text).join(''))
    expect(rows[0]).toContain('running')
    expect(rows[0]).not.toContain('running?')
    expect(rows[1]).not.toContain('running')
  })

  // Four finished agents once showed with no word on any row.
  test('every engine state has its word, and an ended agent says so', () => {
    const word = (extra: Partial<DrainAgent>, agoS = 600) => agentBars.activity(agent('x', 1, 1, agoS, extra), NOW)
    expect(word({ status: 'pending' })).toBe('running')
    expect(word({ status: 'waiting' })).toBe('running')
    expect(word({ status: 'idle' })).toBe('idle')
    expect(word({ status: 'completed' }, 1)).toBe('done')
    expect(word({ status: 'failed' })).toBe('failed')
    expect(word({ status: 'killed' })).toBe('stopped')
  })

  test('without the engine, the sidecar\'s finished says done; without either, the guess or nothing', () => {
    const word = (extra: Partial<DrainAgent>, agoS: number) => agentBars.activity(agent('x', 1, 1, agoS, extra), NOW)
    expect(word({ finished: true }, 1)).toBe('done')
    expect(word({}, 1)).toBe('running?')
    expect(word({}, 600)).toBeUndefined()
    expect(word({ status: 'something-new' }, 1)).toBe('running?')
    expect(word({ status: 'running', finished: true }, 1)).toBe('running')
  })

  test('finished rows sort after live ones, then by last write', () => {
    const rows = agentBars.agentRows([
      agent('old-done', 1000, 10, 900, { status: 'completed' }),
      agent('new-done', 1000, 10, 60, { finished: true }),
      agent('busy', 1000, 10, 300, { status: 'running', workflow: true }),
    ], NOW).map(r => r.map(s => s.text).join(''))
    expect(rows[0]).toMatch(/busy.*running$/)
    expect(rows[1]).toMatch(/new-done.*done$/)
    expect(rows[2]).toMatch(/old-done.*done$/)
  })

  test('at most five rows, then +N more on the total line', () => {
    const many = Array.from({ length: 7 }, (_, i) => agent(`a${i}`, (i + 1) * 10_000, 1000, 100 + i))
    const rows = agentBars.agentRows(many, NOW)
    expect(rows).toHaveLength(6)
    expect(rows.map(r => r.map(s => s.text).join(''))[5]).toBe('  7 agents · 2.8M tokens processed, each re-read counted · 7k written · +2 more · bars against the largest')
  })

  // Finished agents retire once others fill the screen.
  test('a done row retires once three rows stand above it; the done count keeps it, +N more does not', () => {
    const texts = (list: DrainAgent[]) => agentBars.agentRows(list, NOW).map(r => r.map(s => s.text).join(''))
    const done = (n: number) => Array.from({ length: n }, (_, i) => agent(`done${i}`, 10_000, 100, 60 + i, { status: 'completed' }))
    const busy = (n: number) => Array.from({ length: n }, (_, i) => agent(`busy${i}`, 10_000, 100, 600 + i, { status: 'running', workflow: true }))

    const allDone = texts(done(5))
    expect(allDone).toHaveLength(4)
    expect(allDone.slice(0, 3).map(r => r.trim().split(' ')[0])).toEqual(['done0', 'done1', 'done2'])
    expect(allDone[3]).toMatch(/^ {2}5 done · /)
    expect(allDone[3]).not.toContain('more')

    // Two live rows leave room for one done row, the most recent.
    const mixed = texts([...done(4), ...busy(2)])
    expect(mixed).toHaveLength(4)
    expect(mixed[2]).toMatch(/done0 .*done$/)
    expect(mixed[3]).toMatch(/^ {2}2 running · 4 done · /)
    expect(mixed[3]).not.toContain('more')

    // Live rows past five go to +N more; the retired done rows are not among them.
    const full = texts([...done(2), ...busy(6)])
    expect(full).toHaveLength(6)
    expect(full.slice(0, 5).every(r => r.endsWith('running'))).toBe(true)
    expect(full[5]).toContain('· +1 more')
  })

  test('only done rows retire: failed, stopped and wordless rows keep theirs', () => {
    const rows = agentBars.agentRows([
      ...['a', 'b', 'c'].map((l, i) => agent(l, 1000, 10, 60 + i, { status: 'completed' })),
      agent('broke', 1000, 10, 700, { status: 'failed' }),
      agent('halted', 1000, 10, 800, { status: 'killed' }),
    ], NOW).map(r => r.map(s => s.text).join(''))
    expect(rows).toHaveLength(6)
    expect(rows[3]).toMatch(/broke.*failed$/)
    expect(rows[4]).toMatch(/halted.*stopped$/)
  })

  test('a narrow terminal drops the explanation, the output and the model, then the words and half the bar', () => {
    const list = [agent('rename-executor', 127_592, 11_676, 300), agent('agent-bars', 88_185, 3_329, 300)]
    const at = (cols: number) => agentBars.agentRows(list, NOW, cols).map(plain)
    expect(at(70)[0]).toBe('  rename-executor ▰▰▰▰▰▰▰▰▰▰ held  128k  wrote 12k  opus·high')
    expect(at(50)[0]).toBe('  rename-executor ▰▰▰▰▰▰▰▰▰▰ held  128k  opus·high')
    expect(at(40)[0]).toBe('  rename-executor ▰▰▰▰▰▰▰▰▰▰ held  128k')
    expect(at(30)[0]).toBe('  rename-exec… ▰▰▰▰▰ 128k')
    for (const cols of [70, 50, 40, 30]) for (const r of at(cols)) expect([...r].length).toBeLessThanOrEqual(cols)
  })

  test('no agents, no rows', () => {
    expect(agentBars.agentRows([], NOW)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- end to end, through the mod

// Rows are on by default from 0.4. Before that every saved change stored `agents: false`,
// so only a choice made with /drain agents on|off keeps them off.

const DIR = `${transcript().slice(0, -'.jsonl'.length)}/subagents`
const HINT = { plugin: 'brain-drain', component: 'PromptHint' as const, surface: 'terminal' as const, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }

async function ourRows(ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) {
  return (await ui.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate-end').map(t => t.text)
}

async function boot($: any, on: any, store?: Record<string, unknown>) {
  const w = world(on, {
    ...(store ? { store } : {}),
    context: { tokens: 312000, window: 1000000, percent: 31 },
    files: {
      [transcript()]: lines(USER),
      [`${DIR}/agent-aexec-1.jsonl`]: lines(USER, rec('A', 0, 1000, 5000, 7), rec('A', 1, 1000, 5000, 400)),
      [`${DIR}/agent-aexec-1.meta.json`]: JSON.stringify({ name: 'exec-hooks', agentType: 'opus-executor' }),
      [`${DIR}/workflows/wf_1/agent-awf-2.jsonl`]: lines(rec('W', 0, 0, 3000, 50)),
      [`${DIR}/workflows/wf_1/agent-awf-2.meta.json`]: JSON.stringify({ agentType: 'general-purpose' }),
    },
  })
  for (const k of w.files.keys()) w.mtimes.set(k, w.clock.now() - 600_000)
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  return w
}

const cmd = (args: string) => ({ command: 'drain', args, origin: { kind: 'composer' } as never, presentation: {} as never })

test('turned off it reads nothing; on, it reads every agent once, then only what each file gained', async ($, on) => {
  const w = await boot($, on, { notifyAsked: 1, prefs: { agents: false, agentsChosen: true } })
  await w.clock.advance(5000)
  await settle()
  let ui = await $.ui.mount(HINT as never)
  expect(await ourRows(ui as never)).toHaveLength(1)
  expect(w.runs.some(r => r[0] === 'tail' && r[2]?.startsWith('+'))).toBe(false)
  await ui.unmount()

  const reply = (await $.command.run(cmd('agents on'))) as { text: string }
  expect(reply.text).toContain('Subagent rows on')
  ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows).toHaveLength(4)
  expect(rows[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ held  6k  wrote 400  opus·high')
  expect(rows[2]).toBe('  general-purpose ▰▰▰▰▰▱▱▱▱▱ held  3k  wrote 50   opus·high')
  expect(rows[3]).toBe('  2 agents · 9k tokens processed, each re-read counted · 450 written · bars against the largest')
  await ui.unmount()

  // The agent writes another response: the next refresh reads from where the last one stopped.
  const path = `${DIR}/agent-aexec-1.jsonl`
  const before = w.files.get(path)!.length
  w.files.set(path, w.files.get(path)! + lines(rec('B', 0, 0, 20000, 100)))
  w.mtimes.set(path, w.clock.now())
  w.runs.length = 0
  await w.clock.advance(5000)
  await settle()
  const tails = w.runs.filter(r => r[0] === 'tail')
  expect(tails).toEqual([['tail', '-c', `+${before + 1}`, path]])
  ui = await $.ui.mount(HINT as never)
  const after = await ourRows(ui as never)
  // The row is the latest response (20k), not the sum of both (27k).
  expect(after[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ holds 20k  wrote 500  opus·high  running?')
  await ui.unmount()

  // No growth, no reads.
  w.runs.length = 0
  await w.clock.advance(5000)
  await settle()
  expect(w.runs.filter(r => r[0] === 'tail')).toHaveLength(0)

  expect(((await $.command.run(cmd('agents'))) as { text: string }).text).toContain('2 agents · 30k tokens processed')
  await $.command.run(cmd('agents off'))
  ui = await $.ui.mount(HINT as never)
  expect(await ourRows(ui as never)).toHaveLength(1)
  await ui.unmount()
  expect((w.store.get('prefs') as { agents: boolean }).agents).toBe(false)
})

test('the first read takes the file whole; an addition longer than one tail catches up over several, whole lines only', async ($, on) => {
  const w = await boot($, on)
  await $.command.run(cmd('agents on'))
  expect(w.runs.filter(r => r[0] === 'tail' && r[2]?.startsWith('+'))).toHaveLength(0)
  const path = `${DIR}/agent-aexec-1.jsonl`
  w.files.set(path, w.files.get(path)! + lines(rec('B', 0, 0, 1000, 10), rec('C', 0, 0, 1000, 10), rec('D', 0, 0, 1000, 10)))
  w.tailCap = 500
  await w.clock.advance(5000)
  await settle()
  expect(w.runs.filter(r => r[0] === 'tail' && r[3] === path).length).toBeGreaterThan(1)
  const ui = await $.ui.mount(HINT as never)
  expect((await ourRows(ui as never))[1]).toBe('  exec-hooks      ▰▰▰▱▱▱▱▱▱▱ held  1k  wrote 430  opus·high')
  await ui.unmount()
})

test('a line longer than one read is passed over, not stalled on', async ($, on) => {
  const w = await boot($, on)
  const path = `${DIR}/agent-aexec-1.jsonl`
  await $.command.run(cmd('agents on'))
  const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })
  w.files.set(path, w.files.get(path)! + lines(huge, rec('B', 0, 0, 1000, 10)))
  w.tailCap = 500
  await w.clock.advance(5000)
  await settle()
  const ui = await $.ui.mount(HINT as never)
  expect((await ourRows(ui as never))[1]).toBe('  exec-hooks      ▰▰▰▱▱▱▱▱▱▱ held  1k  wrote 410  opus·high')
  await ui.unmount()
})

// MC-7035: a running background agent is in Claude Code's own panel, so it gets no row here.
test('an agent the engine lists as running folds into the total line; the workflow agent keeps its row', async ($, on) => {
  on('agent.list', () => ({ value: [{ id: 'aexec-1', description: 'hooks', type: 'opus-executor', status: 'running' }] }))
  await boot($, on)
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows).toHaveLength(3)
  expect(rows[1]).toBe('  general-purpose held  3k  wrote 50  opus·high')
  expect(rows[2]).toBe('  1 running (exec-hooks holds 6k) · 2 agents · 9k tokens processed, each re-read counted · 450 written')
  await ui.unmount()
})

test('a foreground agent the engine lists as running is folded into the total line, as the panel lists it (seen live, 6 November)', async ($, on) => {
  on('agent.list', () => ({ value: [{ id: 'aexec-1', description: 'hooks', type: 'opus-executor', status: 'running' }] }))
  const w = await boot($, on)
  w.files.set(`${DIR}/agent-aexec-1.meta.json`, JSON.stringify({ name: 'exec-hooks', agentType: 'opus-executor', requestShape: 'foreground' }))
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows.some(r => r.includes('exec-hooks') && r.endsWith('running'))).toBe(false)
  expect(rows.some(r => r.includes('1 running (exec-hooks holds 6k)'))).toBe(true)
  await ui.unmount()
})

// Seen live on 14 Nov: an agent writing one long reply ran 53 s and was never counted as running.
test('an agent the engine lists as running is counted before its first request ends, by name alone', async ($, on) => {
  on('agent.list', () => ({ value: [{ id: 'anew-3', description: 'story', type: 'general-purpose', status: 'running' }] }))
  const w = await boot($, on)
  w.files.set(`${DIR}/agent-anew-3.jsonl`, lines(USER))
  w.files.set(`${DIR}/agent-anew-3.meta.json`, JSON.stringify({ name: 'story-writer', agentType: 'general-purpose' }))
  w.mtimes.set(`${DIR}/agent-anew-3.jsonl`, w.clock.now())
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows.some(r => r.includes('story-writer') && !r.includes('1 running'))).toBe(false)
  expect(rows[rows.length - 1]).toMatch(/^ {2}1 running \(story-writer\) · 3 agents · 9k tokens processed/)
  await ui.unmount()
})

test('an agent with no finished request and no live status is still left out', async ($, on) => {
  on('agent.list', () => ({ value: [{ id: 'anew-3', description: 'story', type: 'general-purpose', status: 'completed' }] }))
  const w = await boot($, on)
  w.files.set(`${DIR}/agent-anew-3.jsonl`, lines(USER))
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows[rows.length - 1]).toMatch(/^ {2}2 agents · 9k tokens processed/)
  await ui.unmount()
})

test('a panel agent with no size yet is named without one after those that have one', () => {
  const a = (id: string, label: string, requests: number, context: number): DrainAgent =>
    ({ id, label, tokens: context, output: 0, context, requests, model: '', mtimeMs: NOW, status: 'running' })
  const rows = agentBars.agentRows([a('1', 'alpha', 2, 50000), a('2', 'beta', 0, 0), a('3', 'beta', 0, 0)], NOW).map(plain)
  expect(rows[0]).toMatch(/^ {2}3 running \(alpha holds 50k, beta, –\) · /)
})

test('an agent the engine lists as completed reads done', async ($, on) => {
  on('agent.list', () => ({ value: [{ id: 'aexec-1', description: 'hooks', type: 'opus-executor', status: 'completed' }] }))
  await boot($, on)
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  expect((await ourRows(ui as never))[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ held  6k  wrote 400  opus·high  done')
  // A done row's word and bar reach the terminal grey (faint), not green.
  const texts = await (ui as unknown as { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }).findAll({ type: 'Text' })
  const word = texts.find(t => t.text === 'done')!
  expect(word.props.color).toBeUndefined()
  expect(word.props.dimColor).toBe(true)
  expect(texts.find(t => t.text === '▰▰▰▰▰▰▰▰▰▰')!.props.dimColor).toBe(true)
  await ui.unmount()
})

test('a sidecar rewritten with finished: true turns the row to done at the next refresh', async ($, on) => {
  const w = await boot($, on)
  await $.command.run(cmd('agents on'))
  let ui = await $.ui.mount(HINT as never)
  expect((await ourRows(ui as never))[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ held  6k  wrote 400  opus·high')
  await ui.unmount()
  w.files.set(`${DIR}/agent-aexec-1.meta.json`, JSON.stringify({ name: 'exec-hooks', agentType: 'opus-executor', finished: true }))
  await w.clock.advance(5000)
  await settle()
  ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ held  6k  wrote 400  opus·high  done')
  // The workflow agent's sidecar never says finished and no list names it: still no word.
  expect(rows[2]).toBe('  general-purpose ▰▰▰▰▰▱▱▱▱▱ held  3k  wrote 50   opus·high')
  await ui.unmount()
})

test('a session without subagents draws nothing extra', async ($, on) => {
  const w = world(on, { context: { tokens: 1000, window: 1000000, percent: 1 }, files: { [transcript()]: lines(USER) } })
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  expect(await ourRows(ui as never)).toHaveLength(1)
  await ui.unmount()
  expect(((await $.command.run(cmd('agents'))) as { text: string }).text).toBe('No subagents in this session yet.')
  void w
})

describe('rows that share a label (live test, 6 November)', () => {
  test('detailFrom reads the sidecar description, trimmed, or nothing', () => {
    expect(agentBars.detailFrom({ agentType: 'general-purpose', description: ' bg counter ' })).toBe('bg counter')
    expect(agentBars.detailFrom({ agentType: 'general-purpose', description: '' })).toBeUndefined()
    expect(agentBars.detailFrom(undefined)).toBeUndefined()
  })

  test('two done rows of one type show their descriptions; a row of its own type does not', () => {
    const done = { finished: true }
    const text = agentBars.agentText([
      agent('general-purpose', 29_000, 7_000, 60, { ...done, detail: 'fg rivers', effort: 'high' }),
      agent('general-purpose', 36_000, 14_000, 120, { ...done, detail: 'bg counter', effort: 'high' }),
      agent('Explore', 12_000, 2_000, 180, { ...done, detail: 'find the hooks', effort: 'high' }),
    ], NOW)
    const lines = text.split('\n')
    expect(lines[0]!.startsWith('  general-purpose fg rivers  ▰')).toBe(true)
    expect(lines[1]!.startsWith('  general-purpose bg counter ▰')).toBe(true)
    expect(lines[2]!.startsWith('  Explore                    ▰')).toBe(true)
    expect(text).not.toContain('find the hooks')
  })

  test('a narrow terminal drops the descriptions before anything else', () => {
    const done = { finished: true }
    const agents = [
      agent('general-purpose', 29_000, 7_000, 60, { ...done, detail: 'fg rivers' }),
      agent('general-purpose', 36_000, 14_000, 120, { ...done, detail: 'bg counter' }),
    ]
    const wide = agentBars.agentRows(agents, NOW, 200).map(plain)
    expect(wide[0]).toContain('fg rivers')
    const narrow = agentBars.agentRows(agents, NOW, 70).map(plain)
    expect(narrow.join('\n')).not.toContain('fg rivers')
    expect(narrow.every(r => cellWidth(r) <= 70)).toBe(true)
  })
})

test('rows are on for a user who never chose anything', async ($, on) => {
  const w = await boot($, on, { notifyAsked: 1 })
  await w.clock.advance(5000)
  await settle()
  const ui = await $.ui.mount(HINT as never)
  expect(await ourRows(ui as never)).toHaveLength(4)
  await ui.unmount()
})

test('rows are on for a user whose old saved prefs say agents: false without choosing it', async ($, on) => {
  const w = await boot($, on, { notifyAsked: 1, prefs: { style: 'bars', agents: false } })
  await w.clock.advance(5000)
  await settle()
  const ui = await $.ui.mount(HINT as never)
  expect(await ourRows(ui as never)).toHaveLength(4)
  await ui.unmount()
})

test('/drain agents off is kept across sessions', async ($, on) => {
  const w = await boot($, on)
  await $.command.run(cmd('agents off'))
  expect(w.store.get('prefs')).toMatchObject({ agents: false, agentsChosen: true })
})
