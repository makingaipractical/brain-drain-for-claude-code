import { expect, test } from 'claude-code/testing'
import type { TurnStepResult } from 'claude-code'
import { start, world } from './world.ts'

const BAND = (cols = 120) => ({
  plugin: 'fuel-gauge', component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: cols, scroll: { bodyRows: 9 } as never, view: {} as never },
})

async function setup($: any, on: any) {
  const w = world(on, { context: { tokens: 312000, window: 1000000, percent: 31 },
    files: { '/h/.claude/fuel-gauge/account_ttl.json': '{"detected_ttl":300,"detected_at":1}' } })
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="other">other mod</Text> })
  on('prompt.edit', ($2: unknown, e: { text: string; start: number; end: number; inputText: string }) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  on('prompt.submit', () => ({}))
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }): AsyncGenerator<never, TurnStepResult> {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 300000, cache_creation_input_tokens: 12000, model: 'claude-opus-5-5' } }
  })
  await start($)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  return w
}

// JSX keys do not reach the drawn tree, so rows are told apart by their wrap prop and text.
async function rows(ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) {
  const all = await ui.findAll({ type: 'Text' })
  const ours = all.filter(t => t.props.wrap === 'truncate-end').map(t => t.text)
  return { gauge: ours[0], cold: ours[1], all: all.map(t => t.text) }
}

const edit = (text: string, inputText: string) => ({ origin: { kind: 'composer' as const }, text, cursor: text.length, start: text.length, end: text.length, inputText })

test('the band draws the gauge, keeps other mods, and warns only while typing into an expired cache', async ($, on) => {
  const w = await setup($, on)
  await $.command.run({ command: 'fuel', args: 'place above', origin: { kind: 'composer' } as never, presentation: {} as never })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND(), surface })
    expect((await rows(ui)).gauge).toContain('31%')
    expect((await rows(ui)).all).toContain('other mod')
    expect((await rows(ui)).cold).toBeUndefined()
    await ui.unmount()
  }
  await w.clock.advance(301_000)
  // Expired, but the box is empty: no warning yet.
  let ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await rows(ui)).cold).toBeUndefined()
  await ui.unmount()
  // Typing: the box comes back exactly as the editor made it, and the warning appears.
  const box = await ($ as any).prompt.edit(edit('', 'h'))
  expect(box).toMatchObject({ text: 'h', cursor: 1 })
  ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await rows(ui)).cold).toBe('▲ cache expired · your next message re-writes ~312k tokens')
  const red = (await ui.findAll({ type: 'Text', text: '▲ cache expired' })).find(t => t.text === '▲ cache expired')
  expect(red?.props.color).toBe('error')
  await ui.unmount()
  // Narrow terminal: the short form.
  ui = await $.ui.mount({ ...BAND(40), surface: 'terminal' })
  expect((await rows(ui)).cold).toBe('▲ cold · next msg re-writes ~312k')
  await ui.unmount()
  // Cleared box: gone again.
  await ($ as any).prompt.edit({ ...edit('h', ''), start: 0, end: 1, cursor: 1 })
  ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await rows(ui)).cold).toBeUndefined()
  await ui.unmount()
})

test('/fuel style switches live and persists; line uses the status line', async ($, on) => {
  const w = await setup($, on)
  await $.command.run({ command: 'fuel', args: 'place above', origin: { kind: 'composer' } as never, presentation: {} as never })
  const r = await $.command.run({ command: 'fuel', args: 'style line', origin: { kind: 'composer' } as never, presentation: {} as never })
  expect(r.text).toContain('Style: line')
  expect(w.store.get('prefs')).toMatchObject({ style: 'line' })
  expect(w.status.at(-1)).toContain('⛽ 31%')
  let ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await rows(ui)).gauge).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'fuel', args: 'style bars', origin: { kind: 'composer' } as never, presentation: {} as never })
  expect(w.status.at(-1)).toBeUndefined()
  ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await rows(ui)).gauge).toContain('ctx ▰▰▰▱▱▱▱▱▱▱ 31%')
  await ui.unmount()
  const help = await $.command.run({ command: 'fuel', args: 'help', origin: { kind: 'composer' } as never, presentation: {} as never })
  expect(help.text).toContain('/fuel sound on|off')
  const styles = await $.command.run({ command: 'fuel', args: 'styles', origin: { kind: 'composer' } as never, presentation: {} as never })
  expect(styles.text).toContain('gauge')
})

test('the expiry alert fires once, 60 s ahead, only while idle', async ($, on) => {
  const w = await setup($, on)
  await w.clock.advance(239_000)
  expect(w.toasts).toHaveLength(0)
  await w.clock.advance(3_000)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('Cache expires in')
  await w.clock.advance(5_000)
  expect(w.toasts).toHaveLength(1)
})

test('by default the gauge draws under the prompt and keeps the engine hint line', async ($, on) => {
  await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'fuel-gauge', component: 'PromptHint', surface,
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    const r = await rows(ui as never)
    expect(r.gauge).toContain('31%')
    expect(r.all.join(' ')).toContain('other mod')
  }
})

// S3: under the prompt the row narrows to the terminal's width, as the band above it does.
test('under the prompt a narrow terminal gets the narrow form', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ plugin: 'fuel-gauge', component: 'PromptHint', surface: 'terminal', viewport: { columns: 40, rows: 24 },
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
  const gauge = (await rows(ui as never)).gauge!
  expect(gauge).toBe("ctx ▰▰▱▱▱ 31% │ cache ▰▰▰▰▰ 5:00")
  expect([...gauge].length).toBeLessThanOrEqual(40)
  await ui.unmount()
})

// S6: a background agent's turn must not hold the alert off after the main turn ended.
test('a subagent turn that outlives the main turn does not silence the expiry alert', async ($, on) => {
  on('turn.start', ($2: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const w = await setup($, on)
  await $.turn.start({ text: 'hi', turnId: 'main' })
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: '', durationMs: 1000, isAborted: false })
  await $.turn.start({ text: '', turnId: 'sub' })
  for await (const _ of $.turn.step({ turnId: 'sub', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' } as never)) { /* drain */ }
  await w.clock.advance(242_000)
  expect(w.toasts).toHaveLength(1)
})

test('the alert stays quiet while the main turn runs', async ($, on) => {
  on('turn.start', ($2: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const w = await setup($, on)
  await $.turn.start({ text: 'hi', turnId: 'main' })
  await w.clock.advance(242_000)
  expect(w.toasts).toHaveLength(0)
})
