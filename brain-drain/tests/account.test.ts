// MC-8006: each session file names the account its rate limits belong to, so no
// reader has to guess it from the weekly reset moment. All of it correct, or null.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import * as core from '../hooks/core.ts'
import { HOME, sessionFile, settle, start, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const PRIMARY = `${HOME}/.claude/fuel-gauge`
const PERSONAL = { accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001', emailAddress: 'personal@example.com' }
const AGENTS = { accountUuid: 'bbbbbbbb-0000-0000-0000-000000000002', emailAddress: 'agents@example.com' }
const record = (acct: object) => JSON.stringify({ numStartups: 3, oauthAccount: acct })
const STEP_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

function host(on: On, o: WorldOptions = {}): World {
  const w = world(on, o)
  on('turn.step', async function* ($2: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  return w
}

async function step($: { turn: { step: (e: never) => AsyncIterable<unknown> } }): Promise<void> {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) { /* drain */ }
  await settle()
}

// ---------------------------------------------------------------- the rule, pure

test('a record names its account by uuid and email; anything else names none', () => {
  expect(core.accountInRecord(JSON.parse(record(PERSONAL)))).toEqual({ uuid: PERSONAL.accountUuid, email: PERSONAL.emailAddress })
  expect(core.accountInRecord({ oauthAccount: {} })).toBeUndefined()
  expect(core.accountInRecord({ oauthAccount: 'x' })).toBeUndefined()
  expect(core.accountInRecord(undefined)).toBeUndefined()
})

test('the host\'s variables win over the record; a part they leave out comes only from the same account\'s record', () => {
  const rec = JSON.parse(record(AGENTS))
  expect(core.sessionAccount(PERSONAL.accountUuid, PERSONAL.emailAddress, rec)).toEqual({ uuid: PERSONAL.accountUuid, email: PERSONAL.emailAddress, source: 'session' })
  expect(core.sessionAccount(PERSONAL.accountUuid, undefined, rec)).toEqual({ uuid: PERSONAL.accountUuid, email: undefined, source: 'session' })
  expect(core.sessionAccount(AGENTS.accountUuid, undefined, rec)).toEqual({ uuid: AGENTS.accountUuid, email: AGENTS.emailAddress, source: 'session' })
  expect(core.sessionAccount(undefined, 'AGENTS@example.com', rec)).toEqual({ uuid: AGENTS.accountUuid, email: 'AGENTS@example.com', source: 'session' })
  expect(core.sessionAccount(undefined, ' ', rec)).toEqual({ uuid: AGENTS.accountUuid, email: AGENTS.emailAddress, source: 'folder' })
  expect(core.sessionAccount(undefined, undefined, undefined)).toBeUndefined()
})

test('only a record naming another account counts as a change', () => {
  const first: core.Account = { uuid: 'a', email: 'a@x', source: 'folder' }
  expect(core.accountChanged(first, { uuid: 'a', email: 'a@x', source: 'folder' })).toBe(false)
  expect(core.accountChanged(first, { uuid: 'b', email: 'b@x', source: 'folder' })).toBe(true)
  expect(core.accountChanged(first, undefined)).toBe(false)
  expect(core.accountChanged(undefined, { uuid: 'b', source: 'folder' })).toBe(false)
  expect(core.accountChanged({ uuid: 'a', source: 'session' }, { uuid: 'b', source: 'folder' })).toBe(false)
  expect(core.accountFields(undefined)).toEqual({ account_uuid: null, account_email: null, account_source: null })
  expect(core.accountFields('changed')).toEqual({ account_uuid: null, account_email: null, account_source: 'changed' })
})

// ---------------------------------------------------------------- in the session file

test('a terminal session names the account of its home folder\'s record', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: record(AGENTS) } })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: AGENTS.accountUuid, account_email: AGENTS.emailAddress, account_source: 'folder', writer: 'mod' })
})

test('a session on another configuration folder names that folder\'s account, not the home folder\'s', async ($, on) => {
  const w = host(on, {
    env: { CLAUDE_CONFIG_DIR: '/h/.claude-personal/' },
    files: { [`${HOME}/.claude.json`]: record(AGENTS), '/h/.claude-personal/.claude.json': record(PERSONAL) },
  })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_email: PERSONAL.emailAddress, account_source: 'folder' })
})

test('a desktop session names the account its host handed it, though the record names another', async ($, on) => {
  const w = host(on, {
    env: { CLAUDE_CODE_ACCOUNT_UUID: PERSONAL.accountUuid, CLAUDE_CODE_USER_EMAIL: PERSONAL.emailAddress },
    files: { [`${HOME}/.claude.json`]: record(AGENTS) },
  })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: PERSONAL.accountUuid, account_email: PERSONAL.emailAddress, account_source: 'session' })
  // The host's word stands for the process: a later change to the record changes nothing.
  w.files.set(`${HOME}/.claude.json`, record({ accountUuid: 'zzz', emailAddress: 'z@example.com' }))
  await w.clock.advance(120_000)
  await step($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_email: PERSONAL.emailAddress, account_source: 'session' })
})

test('with no record and no variables the file says the account is not known, and is still written', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: '{ not json' } })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: null, account_email: null, account_source: null, writer: 'mod' })
})

test('after a /login to another account the file stops naming one, within a minute, for good', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: record(PERSONAL) } })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_email: PERSONAL.emailAddress })
  w.files.set(`${HOME}/.claude.json`, record(AGENTS))
  await w.clock.advance(10_000)
  await step($)
  // Not checked again yet: the record is read at most once a minute.
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_email: PERSONAL.emailAddress })
  await w.clock.advance(60_000)
  await step($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: null, account_email: null, account_source: 'changed' })
  // Back to the first account: still null, since which login the process spent in between is not known.
  w.files.set(`${HOME}/.claude.json`, record(PERSONAL))
  await w.clock.advance(60_000)
  await step($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: null, account_source: 'changed' })
})

test('a record rewritten for the same account keeps the account named', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: record(PERSONAL) } })
  await start($)
  w.files.set(`${HOME}/.claude.json`, JSON.stringify({ numStartups: 4, oauthAccount: PERSONAL }))
  await w.clock.advance(61_000)
  await step($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: PERSONAL.accountUuid, account_source: 'folder' })
})

test('a record unreadable at the first read is read again a minute later, and its account taken', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: '{ half written' } })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: null })
  w.files.set(`${HOME}/.claude.json`, record(PERSONAL))
  await w.clock.advance(61_000)
  await step($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_email: PERSONAL.emailAddress, account_source: 'folder' })
})

test('a record unreadable for a moment later on is no change of account', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: record(PERSONAL) } })
  await start($)
  w.files.set(`${HOME}/.claude.json`, '{ half written')
  await w.clock.advance(61_000)
  await step($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_email: PERSONAL.emailAddress })
})

// ---------------------------------------------------------------- the labels file

const WORK = { accountUuid: '5ea70000-0000-0000-0000-000000000003', emailAddress: 'work@example.com' }


test('a labels file is an object of strings; anything else gives no labels', () => {
  expect([...core.labelsFrom({ [WORK.accountUuid]: 'work@', [AGENTS.accountUuid]: ' agents@ ' })]).toEqual([
    [WORK.accountUuid, 'work@'],
    [AGENTS.accountUuid, 'agents@'],
  ])
  expect(core.labelsFrom(undefined).size).toBe(0)
  expect(core.labelsFrom(null).size).toBe(0)
  expect(core.labelsFrom('work@').size).toBe(0)
  expect(core.labelsFrom([['a', 'b']]).size).toBe(0)
  // One value not a string: not a map of strings, so none of it is used.
  expect(core.labelsFrom({ [WORK.accountUuid]: 'work@', [AGENTS.accountUuid]: 7 }).size).toBe(0)
  expect(core.labelsFrom({ [WORK.accountUuid]: { label: 'work@' } }).size).toBe(0)
})

test('a label that is empty, too long or holds a line break is left out; the others stay', () => {
  const got = core.labelsFrom({ a: '', b: '   ', c: 'x'.repeat(core.LABEL_MAX + 1), d: 'two\nlines', e: 'x'.repeat(core.LABEL_MAX), [WORK.accountUuid]: 'work@' })
  expect([...got.keys()]).toEqual(['e', WORK.accountUuid])
})

test('a label names the account only when its uuid matches, and never an account not known', () => {
  const labels = core.labelsFrom({ [WORK.accountUuid]: 'work@' })
  const work: core.Account = { uuid: WORK.accountUuid, email: WORK.emailAddress, source: 'folder' }
  const agents: core.Account = { uuid: AGENTS.accountUuid, email: AGENTS.emailAddress, source: 'folder' }
  expect(core.accountLabel(work, labels)).toBe('work@')
  expect(core.accountLabel(agents, labels)).toBe(AGENTS.emailAddress)
  expect(core.accountLabel({ uuid: WORK.accountUuid, source: 'session' }, labels)).toBe('work@')
  // An email alone is no match: the file is keyed by uuid.
  expect(core.accountLabel({ email: WORK.emailAddress, source: 'session' }, labels)).toBe(WORK.emailAddress)
  expect(core.accountLabel('changed', labels)).toBe('account not certain')
  expect(core.accountLabel(undefined, labels)).toBe('account not certain')
  // The session file keeps the email whatever the label.
  expect(core.accountFields(work)).toMatchObject({ account_email: WORK.emailAddress })
})

test('with a labels file the session file still names the email', async ($, on) => {
  const w = host(on, { files: { [`${HOME}/.claude.json`]: record(WORK), [`${HOME}/${core.LABELS_FILE}`]: JSON.stringify({ [WORK.accountUuid]: 'work@' }) } })
  await start($)
  expect(sessionFile(w, PRIMARY)).toMatchObject({ account_uuid: WORK.accountUuid, account_email: WORK.emailAddress, account_source: 'folder' })
})
