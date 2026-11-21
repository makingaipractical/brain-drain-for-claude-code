#!/bin/sh
# Type-check the mod against the types of the Claude Code installed here.
#
# Claude Code unpacks its plugin-authoring types to a temporary folder per
# version. This copies that version's claude-code.d.ts to .types/ (gitignored),
# which tsconfig.brain-drain.json includes, then runs tsc. When this version's
# types are not unpacked yet, the copy already in .types/ is used, with a warning.
#
#   CLAUDE_CODE_TYPES=/path/to/claude-code.d.ts  use that file instead
#   TSC=/path/to/tsc                              use that compiler (default: tsc on PATH)
set -eu
cd "$(dirname "$0")"

src="${CLAUDE_CODE_TYPES:-}"
if [ -z "$src" ]; then
  version=$(claude --version 2>/dev/null | awk '{print $1}')
  for f in "/private/tmp/claude-$(id -u)/bundled-skills/$version"/*/plugin-authoring/types/claude-code.d.ts \
           "${TMPDIR:-/tmp}/claude-$(id -u)/bundled-skills/$version"/*/plugin-authoring/types/claude-code.d.ts; do
    if [ -f "$f" ]; then src="$f"; break; fi
  done
fi
if [ -z "$src" ] && [ -f .types/claude-code.d.ts ]; then
  # Claude Code updated and has not unpacked its new types yet: check against the
  # copy kept from the last run, and say which version wrote it.
  saved=$(head -n 1 .types/claude-code.d.ts | sed -n 's/.*Claude Code \([0-9][0-9.]*[0-9]\).*/\1/p')
  echo "typecheck: no claude-code.d.ts found for Claude Code ${version:-?}; using the saved copy from ${saved:-an unknown version}." >&2
  echo "Open the plugin-authoring skill once in Claude Code to check against ${version:-the installed version}." >&2
  echo "typecheck: types from .types/claude-code.d.ts"
  exec "${TSC:-tsc}" -p tsconfig.brain-drain.json
fi
if [ -z "$src" ] || [ ! -f "$src" ]; then
  echo "typecheck: no claude-code.d.ts found for Claude Code ${version:-?}." >&2
  echo "Open the plugin-authoring skill once in Claude Code, or set CLAUDE_CODE_TYPES." >&2
  exit 2
fi

mkdir -p .types
cp "$src" .types/claude-code.d.ts
echo "typecheck: types from $src"
"${TSC:-tsc}" -p tsconfig.brain-drain.json
