---
name: levels
description: How full this session's context window is, and how much of the account's five-hour and weekly usage is left, read from Brain Drain. Use before a large piece of work or a fan-out of subagents, when a line starting "Brain Drain:" appears in your context, or when asked how full your context is or how much usage is left.
---

# Your levels, from Brain Drain

Brain Drain is a Claude Code mod that reads Claude Code's own figures. Three of them bear on your work.

**Context window:** this session's own working memory: the conversation, files read, command output, instructions. As it nears its limit Claude Code compacts it: older tool output is cleared, the rest is summarised, and instructions given only in the conversation may be lost.

**Five-hour window and week:** the account's usage, not this session's. All activity on the account, in Claude Code and in Claude, counts against the same two limits, so parallel sessions and subagents spend what you were counting on. Each resets at a time Brain Drain reports.

## Reading them

1. **The notice.** When the context passes a level the user chose (offered by default: 20, 30, 35 and 50%), Brain Drain adds a short note to your context, a line of facts and then what to do:
   `Brain Drain: context 36% (362k of 1M) · 5-hour window 82%, resets 18:20 · week 40% (pace line 48%)`
   `Consider closing: finish the piece in hand and close the session, unless it clearly makes sense to go on.`
   Each level is told once, and again after a compaction. The 5-hour and weekly figures ride along as facts; they have thresholds of their own only if the user turned them on. The pace line is the share of the week gone since the weekly reset, plus a margin; above it, the week is being spent faster than it lasts. The line after the facts is the user's instruction for that level, theirs or the default they accepted: follow it.
2. **The session file**, when no line has arrived. Brain Drain writes one file per interactive session, named by the session id Claude Code puts in `CLAUDE_CODE_SESSION_ID`:
   ```bash
   f=~/.claude/fuel-gauge-mod/$CLAUDE_CODE_SESSION_ID.json; [ -f "$f" ] || f=~/.claude/fuel-gauge/$CLAUDE_CODE_SESSION_ID.json; cat "$f"
   ```
   `used_percentage` of `context_window_size` is the context. `rate_limit_5h_pct` and `rate_limit_7d_pct` are the two windows (-1: not reported), `rate_limit_5h_reset` and `rate_limit_7d_reset` their reset times in Unix seconds. `timestamp` says how old the reading is. `context_unknown: true` means just compacted or cleared: no figure until the next reply.
   A `claude -p` run writes no file; there only the notice line reports. A subagent gets no notice line, and the file describes the main session, not the subagent.
3. **Neither.** Brain Drain is not installed here, or not telling you. Say that you cannot see your levels; the user sees them with `/context` and `/usage`.

## What a level means for the work

The project's own rules on thresholds come first. Where it has none:

- Never call the context full, or wind down for its sake, without a figure. Read it first (above).
- A notice's own words say what to do at that level; with the defaults: at 20%, carry on; from 30%, finish the piece in hand, commit it, and start nothing new; from 35%, finish the piece in hand and close unless going on clearly makes sense; from 50%, finish the piece, commit it, write a summary of where things stand, and close.
- With no notice to go by, from 50% finish the piece in hand and save it before starting anything large, and nearer the limit write down where you are somewhere that survives compaction (a file, a ticket).
- With the five-hour window nearly spent, do not fan out subagents: each draws on the same window, and one cut off mid-run leaves half-done work. Work one at a time, or stop at a clean point and name the reset time.
- With the week above its pace line, prefer the smaller way to the same result.

Never change the user's Brain Drain settings unasked (`/drain` commands, thresholds, style, its saved data): they are the user's. Report what you read, and suggest a change if one would help.

Sources: context window and compaction, code.claude.com/docs/en/glossary; shared limits, support.claude.com/en/articles/11145838; `/usage` and what drives limits, code.claude.com/docs/en/whats-new/2026-w16; `CLAUDE_CODE_SESSION_ID`, code.claude.com/docs/en/env-vars; everything about Brain Drain, its own code.
