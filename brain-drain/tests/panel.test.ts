// Anthropic's VS Code chat panel. It raises the band above the prompt and no hint
// line under it (seen live on 13 Nov 2026 with extension 2.1.323, MC-7763), so the
// gauge draws in the band there, as in the Claude desktop app. Until then the
// panel offered a mod only the pinned status line, and the mod pinned a short
// line there (MC-7430); that line is gone.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { settle, start, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const STEP_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 300000, cache_creation_input_tokens: 12000, model: 'claude-opus-5-5' }
const CMD = (args: string) => ({ command: 'drain', args, origin: { kind: 'composer' } as never, presentation: {} as never })
const LIMITS = [{ kind: 'five_hour' as const, percentUsed: 62 }, { kind: 'seven_day' as const, percentUsed: 41 }]
const BAND = {
  plugin: 'brain-drain', component: 'AbovePrompt' as const, surface: 'vscode' as const,
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { bodyRows: 9 } as never, view: {} as never },
}
const HINT = { plugin: 'brain-drain', component: 'PromptHint' as const, surface: 'vscode' as const, props: { isDraft: false, isWorking: false, hint: '' } }

function host(on: On, o: WorldOptions = {}): World {
  const w = world(on, { context: { tokens: 310000, window: 1000000, percent: 31 }, rateLimits: LIMITS, ...o })
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  return w
}

async function step($: Engine): Promise<void> {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  await settle()
}

async function tick(w: World): Promise<void> {
  await w.clock.advance(1000)
  await settle()
}

/** The gauge's own rows in a drawn tree (they truncate at the end; other text does not). */
async function gauge($: Engine, target: typeof BAND | typeof HINT): Promise<string[]> {
  const ui = await $.ui.mount(target as never)
  const all = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return all.filter(t => t.props.wrap === 'truncate-end').map(t => t.text)
}

test('a panel session draws the full gauge in the band and pins no line', async ($, on) => {
  // As in the panel: session.start says not interactive and nothing draws yet.
  const w = host(on, { store: { notifyAsked: 1, prefs: { style: 'minimal' } } })
  w.surfaces = []
  await start($, false)
  w.surfaces = ['vscode']
  await step($)
  await tick(w)
  expect((await gauge($, BAND))[0]).toContain('31%')
  expect(await gauge($, HINT)).toEqual([])
  expect(w.status.filter(Boolean)).toEqual([])
})

test('the line style in the panel pins the full line, and the band stays empty', async ($, on) => {
  const w = host(on, { store: { notifyAsked: 1, prefs: { style: 'line' } } })
  w.surfaces = ['vscode']
  await start($, false)
  await step($)
  await tick(w)
  expect(w.status.at(-1)).toContain('🧠 31%')
  expect(await gauge($, BAND)).toEqual([])
})

test('style off draws nothing in the panel; switching back draws the band', async ($, on) => {
  const w = host(on, { store: { notifyAsked: 1, prefs: { style: 'off' } } })
  w.surfaces = ['vscode']
  await start($, false)
  await step($)
  await tick(w)
  expect(w.status.filter(Boolean)).toEqual([])
  expect(await gauge($, BAND)).toEqual([])
  const r = (await $.command.run(CMD('style gauge'))) as { text: string }
  expect(r.text).toBe('Style: gauge.')
  expect((await gauge($, BAND)).join(' ')).toContain('69% left')
})

test('a terminal session keeps its style: nothing pinned for a band style, the full line for line', async ($, on) => {
  const w = host(on, { store: { notifyAsked: 1, prefs: { style: 'minimal' } } })
  await start($)
  await step($)
  await tick(w)
  expect(w.status.filter(Boolean)).toEqual([])
  const r = (await $.command.run(CMD('style line'))) as { text: string }
  expect(r.text).not.toContain('chat panel')
  expect(w.status.at(-1)).toContain('🧠 31%')
})

test('a terminal started from inside a panel session, carrying its entrypoint, keeps its style', async ($, on) => {
  const w = host(on, { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, store: { notifyAsked: 1, prefs: { style: 'minimal' } } })
  await start($)
  await step($)
  await tick(w)
  expect(w.status.filter(Boolean)).toEqual([])
})

test('a -p run started inside a panel session pins nothing', async ($, on) => {
  const w = host(on, { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } })
  w.surfaces = []
  await start($, false)
  await step($)
  await tick(w)
  expect(w.status.filter(Boolean)).toEqual([])
})
