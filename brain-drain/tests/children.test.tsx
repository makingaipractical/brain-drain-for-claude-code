import { describe, expect, test } from 'claude-code/testing'
import * as children from '../hooks/children.ts'
import { HOME, LEGAL_CHECK_PATH, ROOT, SID, settle, start, transcript, world } from './world.ts'

// MC-7061: a Claude Code started from a session's Bash call announces itself to that session.
const PARENT = 'feedface-1111-2222-3333-444444444444'
const CHILD = 'c0ffee00-5555-6666-7777-888888888888'
const DIR = `${HOME}/.claude/${children.CHILDREN_DIR}`

describe('children, pure', () => {
  test('a parent is the inherited session id, never the session itself or junk', () => {
    expect(children.parentOf(PARENT, SID)).toBe(PARENT)
    expect(children.parentOf(SID, SID)).toBeUndefined()
    expect(children.parentOf(undefined, SID)).toBeUndefined()
    expect(children.parentOf('../../etc', SID)).toBeUndefined()
  })

  test('a record parses only whole, and a bad pid is dropped', () => {
    const rec = { v: 1, parent: PARENT, session: CHILD, startedAt: 5, root: '/a', cwd: '/a', interactive: false, pid: 4242 }
    expect(children.parseRecord(rec)).toEqual(rec)
    expect(children.parseRecord({ ...rec, pid: 1 })).toEqual({ ...rec, pid: undefined } as never)
    expect(children.parseRecord({ ...rec, v: 2 })).toBeUndefined()
    expect(children.parseRecord({ ...rec, parent: 7 })).toBeUndefined()
  })

  test('the legal rule: any mounted volume is refused; a marker is looked for up to the home folder', () => {
    expect(children.onVolume('/Volumes/Anything/x')).toBe(true)
    expect(children.onVolume('/Users/me/x')).toBe(false)
    expect(children.ancestors('/h/a/b', '/h')).toEqual(['/h/a/b', '/h/a'])
    expect(children.ancestors('/work/proj', '/h')).toEqual(['/work/proj', '/work'])
  })

  test('the legal check clears a folder only on exit 0 and an `open` line for each folder (MC-7401)', () => {
    expect(children.legalCheckClears(0, 'open   /a\nopen   /b\n', 2)).toBe(true)
    expect(children.legalCheckClears(0, 'open   /a\nLEGAL  /b\n', 2)).toBe(false)
    expect(children.legalCheckClears(0, 'open   /a\n', 2)).toBe(false)
    expect(children.legalCheckClears(1, 'open   /a\n', 1)).toBe(false)
    expect(children.legalCheckClears(0, '', 1)).toBe(false)
    expect(children.legalCheckClears(0, 'opened /a\n', 1)).toBe(false)
    expect(`${HOME}/.claude/${children.LEGAL_CHECK}`).toBe(LEGAL_CHECK_PATH)
  })

  test('where the child\'s transcript may be, its label, its run time', () => {
    const rec = { v: 1 as const, parent: PARENT, session: CHILD, startedAt: 0, root: '/a_b', cwd: '/a_b/c', interactive: false }
    expect(children.transcriptCandidates('/h/.claude/projects', rec)).toEqual([
      `/h/.claude/projects/-a-b/${CHILD}.jsonl`, `/h/.claude/projects/-a-b-c/${CHILD}.jsonl`,
    ])
    expect(children.childLabel(rec, undefined)).toBe('claude -p')
    expect(children.childLabel({ ...rec, interactive: true }, undefined)).toBe('claude')
    expect(children.childLabel(rec, 'modtest')).toBe('modtest')
    expect([45, 720, 3900].map(children.fmtRun)).toEqual(['45s', '12m', '1h05'])
  })
})

const USER = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })
const asst = (id: string, read: number, out: number) => JSON.stringify({
  type: 'assistant', effort: 'low',
  message: { id, model: 'claude-haiku-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: out } },
})
const HINT = { plugin: 'brain-drain', component: 'PromptHint' as const, surface: 'terminal' as const, props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }
const cmd = (args: string) => ({ command: 'drain', args, origin: { kind: 'composer' } as never, presentation: {} as never })
async function ourRows(ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) {
  return (await ui.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate-end').map(t => t.text)
}

test('a session started from another session\'s Bash call writes one record naming its parent', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_ID: PARENT } })
  await start($)
  const rec = JSON.parse(w.files.get(`${DIR}/${SID}.json`)!)
  expect(rec).toMatchObject({ v: 1, parent: PARENT, session: SID, pid: 4242, root: ROOT, cwd: ROOT })
})

test('a session from a clean-environment launcher names its parent through BRAIN_DRAIN_PARENT', async ($, on) => {
  const w = world(on, { env: { BRAIN_DRAIN_PARENT: PARENT } })
  await start($)
  const rec = JSON.parse(w.files.get(`${DIR}/${SID}.json`)!)
  expect(rec).toMatchObject({ v: 1, parent: PARENT, session: SID })
})

test('BRAIN_DRAIN_PARENT that is not a session id writes no record', async ($, on) => {
  const w = world(on, { env: { BRAIN_DRAIN_PARENT: '../../etc' } })
  await start($)
  expect([...w.files.keys()].some(k => k.startsWith(DIR))).toBe(false)
})

test('a top-level session writes no record', async ($, on) => {
  const w = world(on, {})
  await start($)
  expect([...w.files.keys()].some(k => k.startsWith(DIR))).toBe(false)
})

test('a session in a folder under a .legal marker writes no record', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_ID: PARENT }, files: { '/work/.legal': '' } })
  await start($)
  expect([...w.files.keys()].some(k => k.startsWith(DIR))).toBe(false)
})

// A user's own rules reach the mod through their check program. A program of theirs might
// answer LEGAL for every project on a list it keeps; here the check stands in for it,
// answering per folder.
const guardSays = (legal: string[]) => (dirs: string[]) => ({
  exitCode: 0,
  stdout: dirs.map(d => `${legal.some(l => d === l || d.startsWith(`${l}/`)) ? 'LEGAL  ' : 'open   '}${d}\n`).join(''),
})

test('a session the legal check calls legal (a protected project) writes no record', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_ID: PARENT }, legalCheck: guardSays([ROOT]) })
  await start($)
  expect([...w.files.keys()].some(k => k.startsWith(DIR))).toBe(false)
  expect(w.runs.some(r => r[0] === LEGAL_CHECK_PATH && r.length === 2 && r[1] === ROOT)).toBe(true)
})

test('a session the legal check clears writes its record', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_ID: PARENT }, legalCheck: guardSays(['/elsewhere']) })
  await start($)
  expect(w.files.has(`${DIR}/${SID}.json`)).toBe(true)
})

test('a legal check that fails, or answers nothing readable, clears nothing', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_ID: PARENT }, legalCheck: () => 'throw' })
  await start($)
  expect([...w.files.keys()].some(k => k.startsWith(DIR))).toBe(false)
})

test('a legal check that exits non-zero clears nothing', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_SESSION_ID: PARENT }, legalCheck: () => ({ exitCode: 2, stdout: '' }) })
  await start($)
  expect([...w.files.keys()].some(k => k.startsWith(DIR))).toBe(false)
})

/** A parent with one child record from `childRoot`, rows on, two minutes on: what the rows read. */
async function rowsForChild($: any, on: any, childRoot: string, extra: Parameters<typeof world>[1] = {}) {
  const w = world(on, {
    ...extra,
    context: { tokens: 1000, window: 1000000, percent: 1 },
    files: {
      ...(extra.files ?? {}),
      [transcript()]: `${USER}\n`,
      [`${DIR}/${CHILD}.json`]: JSON.stringify({ v: 1, parent: SID, session: CHILD, pid: 777, startedAt: 0, root: childRoot, cwd: childRoot, interactive: false }),
      [`${HOME}/.claude/projects/${childRoot.replace(/[^A-Za-z0-9]/g, '-')}/${CHILD}.jsonl`]: `${USER}\n${asst('m1', 30000, 500)}\n`,
      [`${HOME}/.claude/sessions/777.json`]: JSON.stringify({ pid: 777, sessionId: CHILD, name: 'modtest', nameSource: 'user' }),
    },
  })
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  await $.command.run(cmd('agents on'))
  await w.clock.advance(120_000)
  await settle()
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  await ui.unmount()
  return rows
}

test('the reader shows a child the legal check clears', async ($, on) => {
  const rows = await rowsForChild($, on, '/work/other', { legalCheck: guardSays([]) })
  expect(rows.some(r => r.includes('modtest'))).toBe(true)
})

test('the reader shows no child from a folder the legal check calls legal', async ($, on) => {
  const rows = await rowsForChild($, on, '/cc/Protected_Project', { legalCheck: guardSays(['/cc/Protected_Project']) })
  expect(rows.some(r => r.includes('modtest') || r.includes('running'))).toBe(false)
})

test('the reader shows no child when the legal check cannot answer', async ($, on) => {
  const rows = await rowsForChild($, on, '/work/other', { legalCheck: () => 'throw' })
  expect(rows.some(r => r.includes('modtest') || r.includes('running'))).toBe(false)
})

test('the reader shows no child from under a .legal marker, with no check placed', async ($, on) => {
  const rows = await rowsForChild($, on, '/work/case/sub', { files: { '/work/case/.legal': '' } })
  expect(rows.some(r => r.includes('modtest') || r.includes('running'))).toBe(false)
})

test('the reader shows no child from a mounted volume, and never asks the check about it', async ($, on) => {
  let asked = false
  const rows = await rowsForChild($, on, '/Volumes/Disk/proj', { legalCheck: d => { asked = true; return guardSays([])(d) } })
  expect(rows.some(r => r.includes('modtest') || r.includes('running'))).toBe(false)
  expect(asked).toBe(false)
})

test('the parent shows its child with its name and run time; done once its process is gone', async ($, on) => {
  const childRoot = '/work/other'
  const childTranscript = `${HOME}/.claude/projects/-work-other/${CHILD}.jsonl`
  const w = world(on, {
    context: { tokens: 1000, window: 1000000, percent: 1 },
    files: {
      [transcript()]: `${USER}\n`,
      [`${DIR}/${CHILD}.json`]: JSON.stringify({ v: 1, parent: SID, session: CHILD, pid: 777, startedAt: 0, root: childRoot, cwd: childRoot, interactive: false }),
      [`${DIR}/someone-elses-0000-0000-0000.json`]: JSON.stringify({ v: 1, parent: PARENT, session: 'x0000000-0000', startedAt: 0, root: '/w', cwd: '/w', interactive: false }),
      [childTranscript]: `${USER}\n${asst('m1', 30000, 500)}\n`,
      [`${HOME}/.claude/sessions/777.json`]: JSON.stringify({ pid: 777, sessionId: CHILD, name: 'modtest', nameSource: 'user' }),
    },
  })
  // The record was written at the clock's start; the session has run two minutes since.
  const t0 = w.clock.now()
  w.files.set(`${DIR}/${CHILD}.json`, w.files.get(`${DIR}/${CHILD}.json`)!.replace('"startedAt":0', `"startedAt":${t0}`))
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  await $.command.run(cmd('agents on'))
  await w.clock.advance(120_000)
  await settle()
  let ui = await $.ui.mount(HINT as never)
  let rows = await ourRows(ui as never)
  expect(rows).toHaveLength(3)
  expect(rows[1]).toBe('  modtest holds 31k  wrote 500  haiku·low  running 2m')
  expect(rows[2]).toContain('1 running ·')
  await ui.unmount()

  // The process ends: Claude Code removes its record, and the row turns done.
  w.files.delete(`${HOME}/.claude/sessions/777.json`)
  await w.clock.advance(5000)
  await settle()
  ui = await $.ui.mount(HINT as never)
  rows = await ourRows(ui as never)
  expect(rows[1]).toBe('  modtest held  31k  wrote 500  haiku·low  done 2m')
  await ui.unmount()
})

test('a running child shows from its start, its figures a dash until its first response ends (live test, 6 November)', async ($, on) => {
  const childRoot = '/work/other'
  const childTranscript = `${HOME}/.claude/projects/-work-other/${CHILD}.jsonl`
  const w = world(on, {
    context: { tokens: 1000, window: 1000000, percent: 1 },
    files: {
      [transcript()]: `${USER}\n`,
      [`${DIR}/${CHILD}.json`]: JSON.stringify({ v: 1, parent: SID, session: CHILD, pid: 777, startedAt: 0, root: childRoot, cwd: childRoot, interactive: false }),
      [childTranscript]: `${USER}\n`,
      [`${HOME}/.claude/sessions/777.json`]: JSON.stringify({ pid: 777, sessionId: CHILD, name: 'modtest', nameSource: 'user' }),
    },
  })
  const t0 = w.clock.now()
  w.files.set(`${DIR}/${CHILD}.json`, w.files.get(`${DIR}/${CHILD}.json`)!.replace('"startedAt":0', `"startedAt":${t0}`))
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  await $.command.run(cmd('agents on'))
  await w.clock.advance(120_000)
  await settle()
  let ui = await $.ui.mount(HINT as never)
  let rows = await ourRows(ui as never)
  expect(rows[1]).toBe('  modtest holds –  wrote –  running 2m')
  expect(rows[2]).toContain('1 running ·')
  // Nothing is known yet, so the total line says so instead of summing zeros (review of 6 November).
  expect(rows[2]).toContain('· – tokens processed')
  expect(rows[2]).toContain('· – written')
  expect(rows[2]).not.toContain(' 0 ')
  await ui.unmount()

  // Its first response ends: the figures and the model appear.
  w.files.set(childTranscript, `${USER}\n${asst('m1', 30000, 500)}\n`)
  await w.clock.advance(5000)
  await settle()
  ui = await $.ui.mount(HINT as never)
  rows = await ourRows(ui as never)
  expect(rows[1]).toBe('  modtest holds 31k  wrote 500  haiku·low  running 2m')
  await ui.unmount()
})

test('a run that ends before any answer leaves no row', async ($, on) => {
  const childRoot = '/work/other'
  const w = world(on, {
    context: { tokens: 1000, window: 1000000, percent: 1 },
    files: {
      [transcript()]: `${USER}\n`,
      [`${DIR}/${CHILD}.json`]: JSON.stringify({ v: 1, parent: SID, session: CHILD, pid: 777, startedAt: 0, root: childRoot, cwd: childRoot, interactive: false }),
      [`${HOME}/.claude/projects/-work-other/${CHILD}.jsonl`]: `${USER}\n`,
      // No sessions/777.json: the process has already gone.
    },
  })
  const t0 = w.clock.now()
  w.files.set(`${DIR}/${CHILD}.json`, w.files.get(`${DIR}/${CHILD}.json`)!.replace('"startedAt":0', `"startedAt":${t0}`))
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  await $.command.run(cmd('agents on'))
  await w.clock.advance(120_000)
  await settle()
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  expect(rows.some(r => r.includes('claude -p') || r.includes('running') || r.includes('done'))).toBe(false)
  await ui.unmount()
})

test('child records older than 36 hours are removed at session start, with agent rows off', async ($, on) => {
  const rec = (session: string) => JSON.stringify({ v: 1, parent: PARENT, session, startedAt: 0, root: '/w', cwd: '/w', interactive: false })
  const OLD = `${DIR}/a0000000-0000-0000-0000-000000000001.json`
  const NEW = `${DIR}/a0000000-0000-0000-0000-000000000002.json`
  const w = world(on, { files: { [OLD]: rec('a0000000-0000-0000-0000-000000000001'), [NEW]: rec('a0000000-0000-0000-0000-000000000002') } })
  w.mtimes.set(OLD, w.clock.now() - 37 * 3600_000)
  w.mtimes.set(NEW, w.clock.now() - 3600_000)
  await start($)
  expect(w.files.has(OLD)).toBe(false)
  expect(w.files.has(NEW)).toBe(true)
})

/** A parent whose child announced itself `startedAgo` ms before the session started, with no transcript anywhere it looks. */
async function rowsForUnseenChild($: any, on: any, startedAgo: number, after: number) {
  const w = world(on, { context: { tokens: 1000, window: 1000000, percent: 1 }, files: { [transcript()]: `${USER}\n` } })
  w.files.set(`${DIR}/${CHILD}.json`, JSON.stringify({ v: 1, parent: SID, session: CHILD, pid: 777, startedAt: w.clock.now() - startedAgo, root: '/work/other', cwd: '/work/other', interactive: false }))
  on('ui.render', ($2: any, e: any) => { const { Text } = $2.ui.resolve(e); return <Text key="engine">engine hint</Text> })
  await start($)
  await w.clock.advance(after)
  await settle()
  const ui = await $.ui.mount(HINT as never)
  const rows = await ourRows(ui as never)
  await ui.unmount()
  return rows
}

test('a started session whose transcript is not found says so after two minutes, instead of no row', async ($, on) => {
  const rows = await rowsForUnseenChild($, on, 0, 125_000)
  expect(rows.some(r => r.includes('claude -p') && r.includes('no transcript'))).toBe(true)
})

test('before two minutes a missing transcript is still only late: no row', async ($, on) => {
  const rows = await rowsForUnseenChild($, on, 0, 30_000)
  expect(rows.some(r => r.includes('no transcript'))).toBe(false)
})

test('the no-transcript row leaves after an hour', async ($, on) => {
  const rows = await rowsForUnseenChild($, on, 3600_000, 5_000)
  expect(rows.some(r => r.includes('no transcript'))).toBe(false)
})
