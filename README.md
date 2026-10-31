# Brain Drain for Claude Code

How full Claude's context is, when its cache goes cold, and how much of your 5-hour and weekly
limits is left — right under the prompt in Claude Code.

<img src="images/brain-drain-minimal.png" width="496" alt="Claude Code's prompt with Brain Drain's line under it: 🧠 34% │ ◷ 59:59 │ 5h 12% ↻22:40 · wk 25% │ opus·x-high">

Brain Drain is a Claude Code mod: a plugin that runs inside Claude Code and reads its figures
from Claude Code itself. It never calls a model, makes no network requests, and never changes
what you type. The one thing it can add to what Claude reads is a short note when the context
passes set levels, so Claude knows how full its own context is. The first time Brain Drain starts
in an interactive session, it asks whether to turn that note on, and the default it offers is on,
at 20, 30, 35 and 50%; `/drain notify off` stops it at any time. To check
this yourself before installing, clone the repository and run `claude plugin validate ./brain-drain`:
its `hooks:` and `calls:` lines list everything the mod asks Claude Code to do
([Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)).

Not made by or affiliated with Anthropic.

## What it shows

- **Context:** how full the context window is, green, then yellow from 60%, red from 80%.
- **Cache countdown:** how long until the prompt cache expires, using the TTL Claude Code actually
  wrote (one hour or five minutes), read from the session transcript rather than guessed; if that
  cannot be read, the last lifetime seen on this account. Yellow under 60 seconds, red under 15,
  then `expired` (`exp` when the terminal is narrow).
- **Limits:** your 5-hour (`5h`) and weekly (`wk`) usage, yellow from 70%, red from 90%. Hidden
  when Claude Code reports none. The default style also shows when the 5-hour window resets, in
  your local time: `5h 55% ↻18:20`.
- **Model and effort**, for example `opus·medium`.

The context figure reads `–%` before the first reading, `~42%` after `/compact` until the next one,
and `⚠ 42%` when Claude Code reports a context window smaller than the tokens already in it.

Why the cache matters: Claude Code's documentation says that "after a long enough gap, the next
request recomputes the full input and re-establishes the cache, which is why the first turn back
after stepping away can be noticeably slower." It also says that once you go over your plan's
usage limit and draw on usage credits, "Claude Code drops the main conversation to the
five-minute TTL" ([How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)).
The countdown follows that switch.

## What it warns you about

- **A cold cache while you type.** If the cache has already expired, a red line appears under the
  gauge as soon as you start typing, before you send:
  `▲ cache expired · your next message re-writes ~312k tokens`
- **Expiry coming up.** A notice 60 seconds before the cache expires (`/drain warn` changes the
  lead time; `/drain sound on` adds a short chime).
- **What misses cost.** `/drain` lists the cache misses of today and the last 7 days, with the
  tokens re-written and the change in Claude Code's own session cost figure over the turn that
  opened cold. Misses are kept for 60 days.

## Telling Claude its own levels

When the context passes a level, Brain Drain adds a short note to Claude's own context, so the
session knows where it stands instead of guessing: one line of facts, then a line on what to do.

```
Brain Drain: context 36% (362k of 1M) · 5-hour window 82%, resets 18:20 · week 40% (pace line 48%)
Consider closing: finish the piece in hand and close the session, unless it clearly makes sense to go on.
```

- **Setting it up.** The first time Brain Drain starts in an interactive session, it asks, in Claude
  Code's own question dialog, whether to turn the note on. The default it offers is on, at 20, 30,
  35 and 50%. You can pick it, pick Off, or type other levels (`25 40 60`). It asks once; if the
  question is dismissed, the offered default stands and a notice says so. If you changed any notice setting in an
  earlier version, it does not ask, and your settings stay as they were; turning the note on and off
  again cannot be told apart from never touching it, so then it asks.
- **What each level says by default.** At 20 and 30%: for information, carry on. At 35%: consider
  closing; finish the piece in hand and close, unless it clearly makes sense to go on. At 50%: close
  now; finish the piece in hand, commit it, write a summary of where things stand, and end the
  session. Your own words replace these: `/drain notify text context 35 "your words"`. The same
  command with no words silences that level's words, and the line of facts still comes.
- It speaks once per level, after a tool call or when you send a prompt, and again only after
  the figure has dropped back below it. After a compaction, the first figure is told again. Where
  several levels pass at once, the note carries the highest one's words. It speaks to the main
  conversation only, never to subagents.
- The 5-hour and weekly figures ride along in the line. Thresholds of their own are off unless you
  set them: `/drain notify 5h 80 95` for the 5-hour window, `/drain notify week on` for weekly use
  going above the pace line (the share of the week gone since your weekly reset, plus 5 points).
- A skill, `/brain-drain:levels`, tells Claude how to read these figures itself; it loads on its own
  before a large piece of work or when Claude is asked how full its context is.
- Other context levels: `/drain notify context 30 50`. `/drain notify off` turns the note off;
  `/drain notify` shows what is set.
- It works in non-interactive `claude -p` runs too, from the first tool call on, with your saved
  settings, or the default if you never chose; such a run cannot ask. Nor, when we last tested it,
  can a session in Claude Code's VS Code chat panel, which runs as non-interactive. Nothing can arrive before
  Claude Code's first response, because the figures do not exist until then.

For unattended runs, the environment variable `BRAIN_DRAIN_NOTIFY` overrides your saved settings
for one run. It takes `on`, `off`, or JSON with any of these keys: `on`, `context` (a list),
`5h` (a list), `week` (true or false), `margin`, and `text` (keys `"context:35"`, `"5h:80"`,
`"week"`; words given for one level leave the other levels' words as they are). Any JSON value
turns the notice on for that run unless it includes `"on": false`. A run with
`BRAIN_DRAIN_NOTIFY` set is not asked the setup question. For example:

```
BRAIN_DRAIN_NOTIFY='{"context":[30,35],"5h":[80],"text":{"context:35":"stop and write down your state"}}' claude -p "..."
```

## Install

Requires Claude Code v2.1.287 or later (the first version with mods). Tested with v2.1.314 on
macOS, and with v2.1.301 on Linux (Ubuntu 24.04, arm64, in a dev container). Windows untested.

```
claude plugin marketplace add makingaipractical/brain-drain-for-claude-code
claude plugin install brain-drain@brain-drain
```

On Claude Code v2.1.292 or later, one command does both:
`claude plugin install brain-drain --marketplace makingaipractical/brain-drain-for-claude-code`.

Then run `/reload-plugins` in an open session, or start a new one.

The gauge draws in `claude` in any terminal, including VS Code's integrated terminal. Mods also
run in the Code tab of the Claude Desktop app, but Brain Drain has not been tried there yet. It draws nothing in Anthropic's VS Code chat panel
([Mods overview](https://code.claude.com/docs/en/plugins/mods/overview), "Where mods run"), and the
[Brain Drain VS Code extension](https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge)
cannot see chat-panel sessions either: the panel does not run Claude Code's status line (checked on
Claude Code 2.1.296).

To update: `claude plugin update brain-drain@brain-drain`, or turn on auto-update for the
marketplace in `/plugin` → Marketplaces.

**Nothing under the prompt?** Run `/plugin`: the line under the tabs should read
`1 mod active · brain-drain`. Check that `claude --version` is 2.1.287 or later. Mods are switched
off by `disableAllHooks` in your settings, by an organisation's `allowManagedModsOnly` or
`allowManagedHooksOnly` ([settings reference](https://code.claude.com/docs/en/settings-reference#what-runs-under-allowmanagedhooksonly)),
and for one session by `--safe-mode`. `/drain` shows what the mod sees. Mods are new, and a Claude Code update
can break one; if Brain Drain stops drawing,
[please open an issue](https://github.com/makingaipractical/brain-drain-for-claude-code/issues)
with your Claude Code version.

## Commands

| Command | What it does |
|---|---|
| `/drain` | The cache-miss report, the TTL and where it came from, and your settings |
| `/drain styles` | Previews every display style with your current figures |
| `/drain <style>` | Switches style (below) |
| `/drain place below\|above` | Draws under the prompt (default) or in the band above it |
| `/drain warn <seconds>` | Lead time of the expiry notice (default 60; 0 turns it off) |
| `/drain sound on\|off` | A short chime with the expiry notice (off by default) |
| `/drain notify ...` | The notice to Claude, above; `/drain notify` shows its settings |
| `/drain agents on\|off` | Prototype: one bar per subagent under the gauge, showing its context (off by default) |
| `/drain help` | The full list |

Styles:

- `minimal` (default): the figures as numbers, as in the example at the top.
- `bars`: a small bar beside each figure.
- `gauge`: a fuel needle for the context left, from E to F.
- `compact`: the shortest form.
- `line`: one plain line without colour, set as Claude Code's status text instead of drawn under
  the prompt.
- `off`: draws nothing; the session file is still written.

## With the VS Code extension

The two work side by side. The extension's status line bridge writes `~/.claude/fuel-gauge/`,
and while it is connected the mod writes its own copy to `~/.claude/fuel-gauge-mod/` instead, so
neither overwrites the other. If the bridge is not your status line, the mod writes
`~/.claude/fuel-gauge/` itself. In `claude -p` runs it writes no session file. From extension
v0.9.3, while the mod has written a session file in the last 36 hours, the extension does not ask
for Claude Code's status line, so you can keep your own.

## What it touches

- Reads: Claude Code's own figures and settings (to see whether the VS Code extension's bridge is
  connected), the end of the current session's transcript (for the exact cache TTL; with agent
  bars on, also the subagent transcripts beside it), and `account_ttl.json`.
- Writes: one file per session and `account_ttl.json`, in the folder described above, plus its
  own saved data in Claude Code's plugin storage.
- Removes: its own session files older than 36 hours from `~/.claude/fuel-gauge-mod/`, and
  leftover temp files.
- Runs `tail`, `mv` and `rm` on those files only, and plays a bundled chime if you turn sound on.
  Nothing else.

To remove it: `claude plugin uninstall brain-drain@brain-drain`. Uninstalling leaves the session
files in `~/.claude/fuel-gauge-mod/`; delete that folder if you want them gone.

## Contact

Questions go in [Discussions](https://github.com/makingaipractical/brain-drain-for-claude-code/discussions); bugs and ideas go in
[the issues](https://github.com/makingaipractical/brain-drain-for-claude-code/issues). What changed in each version is in [CHANGELOG.md](CHANGELOG.md).
If you would rather not use GitHub, or want to talk about something that does not belong on a
public tracker, email [info@makingaipractical.com](mailto:info@makingaipractical.com). A security
problem is best reported privately: [SECURITY.md](SECURITY.md) says how.

## Licence

MIT
