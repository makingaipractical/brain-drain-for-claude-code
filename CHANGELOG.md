# Changelog

What changed in each version of Brain Drain for Claude Code, the mod. Update with
`claude plugin update brain-drain@brain-drain`, then `/reload-plugins`.

## 0.3.0 — 2026-10-31

- **Brain Drain asks whether Claude should be told how full its context is.** The first time it
  starts in an interactive session, it asks, offering on at 20, 30, 35 and 50% as the default; you
  can also pick Off or type other levels. When the context passes a level, Brain Drain adds a short
  note to what Claude reads: a line of facts, then what to do. At 20 and 30% it is for information;
  at 35% it suggests finishing the piece in hand and closing, unless going on clearly makes sense;
  at 50% it says to close now: finish the piece, commit it, write a summary. Until now this notice
  was off unless you turned it on, spoke at 70% and 90% only, and stated facts alone. Each level is
  told once, and again after a compaction. `/drain notify off` stops it; `/drain notify context 30 50`
  sets other levels; `/drain notify text context 35 "..."` replaces a level's words. If you had
  changed any notice setting, you are not asked and your settings stay as they were; if you only
  turned it on and off again, that cannot be told apart from never touching it, so you are asked.
  A question left unanswered leaves the default on. `claude -p` runs cannot ask: they get the note
  with your saved settings, or the default. The 5-hour and weekly thresholds are now off unless
  you set them (`/drain notify 5h 80 95`, `/drain notify week on`); their figures still appear in
  the line.
- **Subagent rows show each agent's context.** With `/drain agents on`, a row's number and bar were
  every request of that agent added up, cache re-reads included, so an agent holding 156k of
  context read 3.5M. A row now shows the agent's context as of its latest request, the same figure
  Claude Code reports when the agent finishes. The added-up figure stays on the total line, now
  called "tokens processed".

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
