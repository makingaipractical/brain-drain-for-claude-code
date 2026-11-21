// Pure logic for the Claude Code processes a session started: no `$`, so the tests call it directly.
//
// A `claude` started from a session's Bash call inherits CLAUDE_CODE_SESSION_ID, the
// session that started it (verified on 2.1.318, 6 November 2026). So the child's own
// mod announces itself: one small file in `~/.claude/fuel-gauge/children/`, named
// after the child's session, naming its parent. The parent's mod lists the files
// that name it and reads each child's transcript as it reads a subagent's. No `ps`,
// and no other process's environment is read. A child that does not load the mod
// (`--bare`, or an install without it) writes no file and does not show.
//
// A launcher that starts its `claude` from a clean environment (`env -i`, or a
// script that drops inherited CLAUDE_ variables on purpose) loses that id. Such a
// launcher names the parent in BRAIN_DRAIN_PARENT instead: a
// plain session id of our own, so passing it carries none of Claude Code's own marks.

/** The folder under `~/.claude/` the records live in, beside the session files. */
export const CHILDREN_DIR = 'fuel-gauge/children'
/**
 * A started session whose transcript is still not found this long after it announced
 * itself gets a row saying so, instead of no row at all: its record is there, so it
 * runs, but its transcript is under another folder than this session's (an account
 * folder that does not share `projects/`). The row stays for an hour.
 */
export const TRANSCRIPT_GRACE_MS = 120_000
export const UNSEEN_ROW_MS = 3600_000

/** Records older than this are removed by any mod that lists the folder. */
export const CHILD_MAX_AGE_MS = 36 * 3600_000

export type ChildRecord = {
  v: 1
  /** The session that started this one: its inherited CLAUDE_CODE_SESSION_ID. */
  parent: string
  session: string
  /** The child's own process (`sh -c 'echo $PPID'` from its mod), for the liveness check. */
  pid?: number
  /** Epoch milliseconds, when the child's mod wrote the record. */
  startedAt: number
  /** The session's root and working folder: the transcript sits under one of them. */
  root: string
  cwd: string
  interactive: boolean
}

/** A record read from disk, or undefined when it is not one. */
export function parseRecord(v: unknown): ChildRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  if (r.v !== 1 || typeof r.parent !== 'string' || typeof r.session !== 'string' || typeof r.startedAt !== 'number') return undefined
  if (typeof r.root !== 'string' || typeof r.cwd !== 'string') return undefined
  return {
    v: 1, parent: r.parent, session: r.session, startedAt: r.startedAt, root: r.root, cwd: r.cwd,
    interactive: r.interactive === true,
    ...(typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 1 ? { pid: r.pid } : {}),
  }
}

/** Whether this session was started by another one, and which: the inherited id, when it is not its own. Called with the inherited CLAUDE_CODE_SESSION_ID first, then with BRAIN_DRAIN_PARENT. */
export function parentOf(inherited: string | undefined, own: string): string | undefined {
  const p = inherited?.trim()
  return p && p !== own && /^[A-Za-z0-9-]{8,80}$/.test(p) ? p : undefined
}

/** A session id safe to use as a file name. */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9-]{8,80}$/.test(id)
}

/**
 * The rule for folders a session must not show, as far as a mod can apply it on
 * its own: anything on a mounted volume is refused outright, since looking for a
 * marker there would already be looking inside it; anything under a folder that
 * carries a `.legal` marker is refused too. This is the first half, which needs
 * no file system; `ancestors` lists where to look for the marker. A user's own
 * rules (a list of protected projects, say) are asked through the program at
 * `LEGAL_CHECK`.
 */
export function onVolume(dir: string): boolean {
  return dir === '/Volumes' || dir.startsWith('/Volumes/')
}

/** The folders from `dir` up to the root, the home folder and above left out: where a `.legal` marker could sit. */
export function ancestors(dir: string, home?: string): string[] {
  const out: string[] = []
  let d = dir.replace(/\/+$/, '')
  const stop = home?.replace(/\/+$/, '')
  while (d && d !== '/') {
    if (stop && (d === stop || stop.startsWith(`${d}/`))) break
    out.push(d)
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return out
}

/**
 * Where, under `~/.claude/`, a user may place a program that judges folders by
 * rules of their own. It is run with the folders as arguments and must exit 0
 * and print one line per folder, `open` first on each line for a folder that is
 * not legal (`LEGAL` first, say, for one that is). When it is there,
 * nothing it does not clear is announced or shown.
 */
export const LEGAL_CHECK = 'fuel-gauge/legal-check'

/**
 * Whether the legal check's answer clears every one of `count` folders: exit 0
 * and `count` lines, each starting `open`. Anything else counts as legal (a
 * `LEGAL` line, a failure, too few lines, an empty answer), since a check that
 * cannot be read clears nothing.
 */
export function legalCheckClears(exitCode: number, stdout: string, count: number): boolean {
  if (exitCode !== 0 || count < 1) return false
  const lines = stdout.split('\n').filter(l => l.trim() !== '')
  return lines.length === count && lines.every(l => /^open(\s|$)/.test(l))
}

/** The transcript paths a child's session may have, under the parent's projects folder. */
export function transcriptCandidates(projectsDir: string, rec: ChildRecord): string[] {
  const slug = (d: string) => d.replace(/[^A-Za-z0-9]/g, '-')
  return [...new Set([rec.root, rec.cwd])].map(d => `${projectsDir}/${slug(d)}/${rec.session}.jsonl`)
}

/**
 * The child's label: the name a script gave it with `--name`, else what it is.
 */
export function childLabel(rec: ChildRecord, userName: string | undefined): string {
  const n = userName?.trim()
  if (n) return n
  return rec.interactive ? 'claude' : 'claude -p'
}

/** A run time in a few characters: `45s`, `12m`, `1h05`. */
export function fmtRun(s: number): string {
  const t = Math.max(0, Math.round(s))
  if (t < 60) return `${t}s`
  if (t < 3600) return `${Math.floor(t / 60)}m`
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`
}
