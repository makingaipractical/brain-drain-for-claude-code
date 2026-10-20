import { describe, expect, test } from 'claude-code/testing'
import * as agentBars from '../hooks/agents.ts'
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
    agentBars.feed(acc, file.slice(acc.offset))
    expect(acc.offset).toBe(file.length)
    expect(acc.requests).toBe(2)
    expect(acc.output).toBe(320)
    expect(acc.tokens).toBe(2 + 1000 + 5000 + 300 + (2 + 8000 + 20))
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
const agent = (label: string, tokens: number, output: number, agoS: number, extra: Partial<DrainAgent> = {}): DrainAgent => ({
  id: `a${label}`, label, tokens, output, requests: 10, model: 'claude-opus-5-5', effort: 'high', mtimeMs: NOW - agoS * 1000, ...extra,
})

describe('rows', () => {
  test('one row per agent, bars scaled to the largest, a guessed running state, one total line', () => {
    const text = agentBars.agentText([
      agent('rename-executor', 1_258_861, 11_676, 300, { effort: 'medium' }),
      agent('agent-bars', 354_129, 3_329, 5),
    ], NOW)
    expect(text).toBe([
      '  agent-bars      ▰▰▰▱▱▱▱▱▱▱ 354k  out 3k   opus·high  running?',
      '  rename-executor ▰▰▰▰▰▰▰▰▰▰ 1.3M  out 12k  opus·medium',
      '  2 agents · 1.6M tokens · 15k out',
    ].join('\n'))
  })

  test('the engine\'s own word beats the guess', () => {
    const rows = agentBars.agentRows([
      agent('busy', 1000, 10, 600, { status: 'running' }),
      agent('done', 1000, 10, 1, { status: 'completed' }),
    ], NOW).map(r => r.map(s => s.text).join(''))
    expect(rows[0]).toContain('running')
    expect(rows[0]).not.toContain('running?')
    expect(rows[1]).not.toContain('running')
  })

  test('at most five rows, then +N more on the total line', () => {
    const many = Array.from({ length: 7 }, (_, i) => agent(`a${i}`, (i + 1) * 100_000, 1000, 100 + i))
    const rows = agentBars.agentRows(many, NOW)
    expect(rows).toHaveLength(6)
    expect(rows.map(r => r.map(s => s.text).join(''))[5]).toBe('  7 agents · 2.8M tokens · 7k out · +2 more')
  })

  test('a narrow terminal drops the output and the model before the bar', () => {
    const rows = agentBars.agentRows([agent('rename-executor', 1_258_861, 11_676, 300)], NOW, 40).map(r => r.map(s => s.text).join(''))
    expect(rows[0]).toBe('  rename-executor ▰▰▰▰▰▰▰▰▰▰ 1.3M')
    for (const r of rows) expect([...r].length).toBeLessThanOrEqual(40)
  })

  test('no agents, no rows', () => {
    expect(agentBars.agentRows([], NOW)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- end to end, through the mod

const DIR = `${transcript().slice(0, -'.jsonl'.length)}/subagents`
const HINT = { plugin: 'brain-drain', component: 'PromptHint' as const, surface: 'terminal' as const, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }

async function ourRows(ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) {
  return (await ui.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate-end').map(t => t.text)
}

async function boot($: any, on: any) {
  const w = world(on, {
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

test('off by default; on, it reads every agent once, then only what each file gained', async ($, on) => {
  const w = await boot($, on)
  await w.clock.advance(5000)
  await settle()
  let ui = await $.ui.mount(HINT as never)
  expect(await ourRows(ui as never)).toHaveLength(1)
  expect(w.runs.some(r => r[0] === 'tail' && r[2]?.startsWith('+'))).toBe(false)
  await ui.unmount()

  const reply = (await $.command.run(cmd('agents on'))) as { text: string }
  expect(reply.text).toContain('Subagent bars on')
  ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows).toHaveLength(4)
  expect(rows[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ 6k  out 400  opus·high')
  expect(rows[2]).toBe('  general-purpose ▰▰▰▰▰▱▱▱▱▱ 3k  out 50   opus·high')
  expect(rows[3]).toBe('  2 agents · 9k tokens · 450 out')
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
  expect(after[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ 27k  out 500  opus·high  running?')
  await ui.unmount()

  // No growth, no reads.
  w.runs.length = 0
  await w.clock.advance(5000)
  await settle()
  expect(w.runs.filter(r => r[0] === 'tail')).toHaveLength(0)

  expect(((await $.command.run(cmd('agents'))) as { text: string }).text).toContain('2 agents · 30k tokens')
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
  expect((await ourRows(ui as never))[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ 9k  out 430  opus·high')
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
  expect((await ourRows(ui as never))[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ 7k  out 410  opus·high')
  await ui.unmount()
})

test('an agent the engine lists as running says so, without the question mark', async ($, on) => {
  on('agent.list', () => ({ value: [{ id: 'aexec-1', description: 'hooks', type: 'opus-executor', status: 'running' }] }))
  await boot($, on)
  await $.command.run(cmd('agents on'))
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows[1]).toBe('  exec-hooks      ▰▰▰▰▰▰▰▰▰▰ 6k  out 400  opus·high  running')
  expect(rows[2]).not.toContain('running')
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
