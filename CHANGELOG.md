# Changelog

What changed in each version of Brain Drain for Claude Code, the mod. Update with
`claude plugin update brain-drain@brain-drain`, then `/reload-plugins`.

## 0.4.1 — 2026-11-23

- **A started session under another configuration folder no longer reads done while it runs.**
  The parent looked for a started session's own record only under `~/.claude`. A started session
  now names its configuration folder (`CLAUDE_CONFIG_DIR`, when set) in its record in
  `~/.claude/fuel-gauge/children/`, and the parent looks in that folder first. A configuration
  folder whose path lies under `/Volumes` (macOS), under a folder holding a `.legal` marker, or
  not cleared by your legal check is left out of the record, so the parent never opens it.
- **A folder under `/Volumes` is recognised in more spellings.** The check that keeps Brain Drain
  away from mounted drives now also catches the path written in other letter case, with doubled
  slashes, with `.` parts, or by macOS's long name `/System/Volumes/Data/Volumes`, and a path that
  passes through `/Volumes` on its way (`/Volumes/D/../../work`) counts as well. It reads the path's
  letters only and does not follow a link to see where it leads.
- **A Claude Code that cannot say where a session draws no longer stops the agent rows.** Where
  the call that lists a session's surfaces fails, the mod asks the older call for one surface, and
  failing that takes an interactive session to draw in its terminal and a `claude -p` run to draw
  nowhere. A terminal session keeps its agent rows and its file; a `-p` run still writes nothing
  to the folders the gauges read.

## 0.4.0 — 2026-11-21

- **A `claude -p` run writes its session file too, in a folder of its own.** Before, a
  non-interactive run wrote none, so nothing outside the run could read its figures. Its file now
  goes to `~/.claude/fuel-gauge-mod/headless/` once its first figures are in, with the same fields
  as any other session file, and is removed after 6 hours. Neither the VS Code extension nor anything else that lists the session folders
  looks inside it, so a `claude -p` run still never shows in a gauge.
- **Your `labels.json` is no longer removed after 36 hours.** The file that gives an account a short
  name, `~/.claude/fuel-gauge-mod/labels.json`, is one you write yourself (or a tool of yours
  does). The clean-up of old session files counted it as one of them, and since it rarely changes,
  it would have been deleted.
- **Agent rows are on by default.** The rows under the gauge for subagents and for the Claude Code
  sessions this session started were a prototype, off unless asked for. They now show unless you
  turn them off with `/drain agents off`, which is remembered. Before this version every saved
  setting stored "off" for the rows too, so only an explicit `/drain agents off` keeps them off now.
  If you turned the rows off before 0.4.0, run `/drain agents off` once more.
- **A started session that cannot be read says so.** When a session this one started has announced
  itself but its transcript is not where Brain Drain looks (for example under another account
  folder), its row reads `no transcript` after two minutes, for an hour, instead of no row at all.
- **A session started from a clean environment can still show under the session that launched
  it.** A `claude` started with `env -i`, or by a launcher that leaves out Claude Code's own
  variables, no longer knows which session started it, so it showed no agent row. Such a launcher
  can now set `BRAIN_DRAIN_PARENT` to the launching session's id (`$CLAUDE_CODE_SESSION_ID`), and
  the row appears as it does for any `claude` started from a Bash call.
- **The note's wording is shared with other tools, and an account can have a short name.** The
  figures now read `5-hour window 86% used` and `week 37% used`. Each reset gives its clock time
  and how long until it, with the weekday and date only when it is not today:
  `resets 22:00 (in 1 h 46 min)`, `resets Sun 22 Nov 08:00 (in 5 d 11 h; pace line 27%)`. A 5-hour
  reset just after midnight is not today, so it gets its date. An optional local file,
  `~/.claude/fuel-gauge-mod/labels.json`, maps an account's id to a short name such as `work@`,
  which the note then uses instead of the email. Brain Drain only reads it, at most once a minute.
  Without it the note shows the email, and a name never replaces `account not certain`.
- **The note to Claude names its account and reads its own time, and comes without a threshold
  too.** Every session, `claude -p` runs included, should know which account it is on, how much of
  it is left and when each window resets. The line of facts now reads
  `Brain Drain, you@example.com, read 20:14: context 11% (110k of 1M) · 5-hour window 75% used, resets 22:00 (in 1 h 46 min) · week 36% used, resets Sun 22 Nov 08:00 (in 5 d 11 h; pace line 27%)`.
  The account is the login's email, or `account` and the start of its id, or `account not
  certain` (no record found, or the login changed during the session). A window whose reset has
  passed shows no figure until the new one is reported. Besides the thresholds, the facts alone
  now go at a session's first prompt or tool call, after a compaction even below every level, when
  the 5-hour window has started again, when the account changes, and 30 minutes after the last
  note. The interval is the new `refresh` setting: `/drain notify refresh <minutes>|off`, or
  `"refresh"` in `BRAIN_DRAIN_NOTIFY`; 0 turns the timed note off. A note on a prompt that never
  went through does not count as told.
- **Each session file names its account.** The 5-hour and weekly figures belong to the account
  the session runs on, and the file did not say which, so anything reading several sessions'
  files had to guess. The file now carries `account_uuid`, `account_email` and `account_source`:
  from the variables a host such as the Desktop app hands the session (`session`), else from the
  configuration folder's `.claude.json` (`folder`). The account fields are `null` when the account
  is not certain: with no record, and after a `/login` to another account on the same folder since
  the session started, when `account_source` reads `changed` for the rest of that process.
- **The gauge in the Claude Desktop app and in VS Code's chat panel.** The Code tab of the Desktop
  app and Anthropic's VS Code chat panel show a mod's band above the prompt box but never the line
  under it, where the gauge draws by default, so nothing showed. In both the gauge now draws in the
  band, whatever `/drain place` says; the `line` style uses the status line, and `/drain off` hides
  it. Both start their sessions as non-interactive; a session in either now writes its session
  file from its first request, and a `claude -p` run started from inside one writes only to the
  headless folder (see the first entry).
- **The context notice notices a compaction where an organization manages Claude Code.** After a
  compaction the earlier notes are only in the summary, so the first figure after it is told
  again. The mod learned of the compaction from Claude Code's compaction event, which a machine
  with managed settings (or a Team or Enterprise login) withholds from the mods a user installs.
  The notice now also counts a large fall in the context figure as a compaction: at least 40% and
  20,000 tokens since the figure it last read. A rewind that large counts too.
- **The cache countdown keeps a colour of its own.** `◷` used to take the context's colour while
  time was comfortable, so a cache with 57 minutes left turned yellow once the context passed its
  warning. It is now green until its own steps: for the one-hour cache yellow from 25 minutes left
  and red from 5; for the five-minute cache yellow under a minute and red under 15 seconds, as
  before. `expired` stays red.
- **The context note says who speaks.** Since Claude Code 2.1.318 a note attached when you send a
  prompt reaches Claude inside your own turn, where it used to arrive as a system message. The line
  of facts now ends `An automatic note from the Brain Drain mod, not typed by the user.`, and each
  level's words open `Set ahead of time for this level:`, so Claude does not read them as
  something you just typed. That line names no author, since a launcher that starts sessions for
  you can set the words too. The line of facts starts `Brain Drain,`, then the account and the
  time the figures were read.
- **Subagent rows say when an agent has finished.** Each row ends with
  `running`, `idle`, `done`, `failed` or `stopped`, as Claude Code reports the agent. Up to now a
  finished agent's row carried no word, so it looked the same as one whose state was unknown.
  Where Claude Code's agent list does not name the agent, the agent's own record beside its
  transcript can still say it finished. A workflow's agents appear in neither, so their rows keep
  the `running?` guess from the transcript's last write. Finished rows sort below the live ones.
- **Running rows turn green, finished rows grey, and the total line counts states.** A `running`
  row's bar and word take your theme's success green, the colour the gauge uses for a context that
  is fine, with the word in bold, so the agent still working is the line that catches the eye. A
  `done` row's bar, size and word are grey. The total line
  opens with the count in each state, `1 running · 2 done · 7.5M tokens processed`, the running
  count in green, and adds the number of all agents when some have no word yet.
- **Finished subagent rows give way.** A `done` row draws only while fewer than three rows stand
  above it, so once other agents fill the block the finished ones retire. A retired agent leaves no
  row and is not part of `+N more`; the total line's `done` count and its token sums still include
  it. Failed and stopped rows stay.
- **A running agent is counted from its start.** The total line counted an agent only once its
  first request had ended, so one that writes a single long reply was missing from `1 running`
  until it was already done. An agent Claude Code lists as running is now counted from its start,
  by name alone until it has a size: `1 running (story-writer)`.
- **Subagent rows sit beside Claude Code's own agent panel instead of repeating it.** The panel
  under the prompt lists each background subagent while it runs, and cannot be hidden. The mod now
  draws a row only for what the panel never shows: finished agents and each agent of a workflow.
  A subagent Claude waits for is listed by the panel while it runs, like a background one. A failed or stopped agent gets its row once the panel lets it go,
  30 seconds after. A running agent the panel lists is named on the total line with its size
  instead: `1 running (opus-executor holds 226k) · 6 done · 29.7M tokens processed`.
- **Claude Code processes that your session started get rows too.** A `claude` or `claude -p` that a
  session starts from a Bash call now shows under the agent rows of that session, with its name
  (`--name`), size, output, model and effort, `running` or `done`, and how long it ran. The row
  appears as soon as it starts; until its first answer is complete its figures read `–`, since
  Claude Code records the sizes only then. The started session's own copy of the mod announces
  it: it writes one small file in
  `~/.claude/fuel-gauge/children/` naming the session that started it, and nothing else. A
  session without the mod (`--bare`) does not show. Nothing is announced or shown for a folder on
  a drive under `/Volumes` (macOS) or under a folder holding a `.legal` marker. If you keep rules of your own
  about which folders must stay private, place a program at `~/.claude/fuel-gauge/legal-check`:
  it is given the folders and must print one line for each, starting `open` for a folder that may
  be shown. A folder it does not clear, or any answer it cannot give, keeps the run unannounced
  and unshown.
- **The figures say what they are.** A row reads `holds 226k  wrote 76k`: what the agent's latest
  request carried (`held` once it stopped), and all it has written. The total line says `tokens
  processed, each re-read counted` and `written`. A failed agent's word is in your theme's warning
  colour; a stopped row is drawn at full ink like the rest, its word saying so.
- **The bar compares, or is not drawn.** It is scaled to the largest row, so a lone agent's bar was
  always full. A single row now has no bar; with two or more the total line says `bars against the
  largest`.
- **Two agents of one type can be told apart.** Rows whose label another row shares add the few
  words the agent was started with, as Claude Code's panel does: `general-purpose bg counter`,
  `general-purpose fg rivers`. A row with a label of its own keeps it short. In a narrow terminal
  these words go first.
- **`5h –` when your plan reports no 5-hour limit.** When Claude Code sends a weekly figure but
  none for the 5-hour window, every style now shows `5h –` before the weekly figure, uncoloured,
  instead of leaving the 5-hour figure out. A missing figure looked like a broken line. With
  neither figure (an API key, or before the first response) both stay hidden. The session file is
  unchanged: it still writes `-1` for a figure Claude Code did not send. The VS Code extension
  shows the same `5h –` from its version 0.10.1.
- **Sessions in Anthropic's VS Code chat panel write their session file.** The panel starts its
  sessions as not interactive, so the mod wrote nothing for them, and the VS Code extension's gauge
  stayed dark there. A session the panel draws on now writes from its first request, as a terminal
  session does. A `claude -p` run, also one started from inside a panel session, writes only to the
  headless folder (see the first entry).

## 0.3.0 — 2026-11-02

- **Brain Drain asks whether Claude should be told how full its context is.** The first time it
  starts in an interactive session, it asks, offering on at 20, 30, 35 and 50% as the default; you
  can also pick Off or type other levels. When the context passes a level, Brain Drain adds a short
  note to what Claude reads: a line of facts, then what to do. At 20% it is for information; at 30%
  it says to finish the piece in hand, commit it and start nothing new; at 35% it suggests
  finishing the piece in hand and closing, unless going on clearly makes sense; at 50% it says to
  close now: finish the piece, commit it, write a summary. Until now this notice was off unless you
  turned it on, spoke at 70% and 90% only, and stated facts alone. Each level is told once, and
  again after a compaction. `/drain notify off` stops it; `/drain notify context 30 50`
  sets other levels; `/drain notify text context 35 "..."` replaces a level's words. If you had
  changed any notice setting, you are not asked and your settings stay as they were; if you only
  turned it on and off again, that cannot be told apart from never touching it, so you are asked.
  A question left unanswered leaves the default on. Sessions that are not interactive cannot ask:
  `claude -p` runs, and, when we last tested it, Claude Code's VS Code chat panel. They get the note
  with your saved settings, or the default. The 5-hour and weekly thresholds are now off unless
  you set them (`/drain notify 5h 80 95`, `/drain notify week on`); their figures still appear in
  the line.
- **Subagent rows show each agent's context.** With `/drain agents on`, a row's number and bar were
  every request of that agent added up, cache re-reads included, so an agent holding 156k of
  context read 3.5M. A row now shows the agent's context as of its latest request. That is close
  to the figure Claude Code reports when the agent finishes, not equal to it: Claude Code's count
  ran 0.5 to 0.9% higher in our test (157k where the row showed 156k). The added-up figure stays on
  the total line, now called "tokens processed".
- **A skill for Claude: `/brain-drain:levels`.** It tells a session how to read its own context
  and the account's 5-hour and weekly usage from Brain Drain: the note when it arrives, otherwise
  the session file Brain Drain writes. Claude loads it by itself before a large piece of work, or
  when asked how full its context is.

## 0.2.1 — 2026-10-21

- **The exact cache TTL on a Team account.** Claude Code 2.1.304 on a Team plan runs a built-in
  security plugin ahead of every mod, and it skips the mod's start-of-session and
  end-of-turn hooks, which were the only place the mod learned where the session's transcript is. The
  mod now finds the transcript itself and reads it when the turn ends, so the TTL is read from the
  transcript again instead of carried over from the last session.
- **No more "its classic.Stop hook was skipped" line.** On a Team login Claude Code
  printed that line at session start, once for each of the two hooks the security plugin skipped. The
  mod no longer has those hooks: it follows `/clear` and `/resume` on its own, and the subagent rows
  find the transcript before the first turn ends. It also looks for the transcript under
  `CLAUDE_CONFIG_DIR` when you set one.

## 0.2.0 — 2026-10-15

- **When the 5-hour window resets.** The default style shows it beside the 5-hour figure, in your
  local time: `5h 55% ↻18:20`. On a narrow terminal the model name is dropped first, then the reset time.
- **The context figure keeps up during a turn.** It is updated from each request Claude Code makes,
  not only when the turn ends.
- **With the VS Code extension:** the mod checks before every write, not only at the start and end of
  a turn, whether the extension's bridge holds the status line.
- **After `/clear`, the line carries on.** Before, it lost your chosen style and other settings, its
  cache clock fell back to 5 minutes and could say "expired" when it was not, and the session file for
  the VS Code extension stopped. Now the new session starts with your settings, the right cache time
  and its own session file. After `/resume` the line switches to the resumed session at once, not at
  your next message.

## 0.1.0 — 2026-10-11

First public version: context, cache countdown, 5-hour and weekly limits, and model and effort,
under Claude Code's prompt; a warning when you start typing into a cold cache; a notice before the
cache expires; the `/drain` cache-miss report; the optional self-notice (`/drain notify`); and the
session file the Brain Drain VS Code extension reads.
