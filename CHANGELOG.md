# Changelog

What changed in each version of Brain Drain for Claude Code, the mod. Update with
`claude plugin update brain-drain@brain-drain`, then `/reload-plugins`.

## Unreleased

- **The exact cache TTL on a Team account.** Claude Code 2.1.304 on a Team plan runs a built-in
  security plugin ahead of every mod, and it skips the mod's start-of-session and
  end-of-turn hooks, which were the only place the mod learned where the session's transcript is. The
  mod now finds the transcript itself and reads it when the turn ends, so the TTL is read from the
  transcript again instead of carried over from the last session.

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
