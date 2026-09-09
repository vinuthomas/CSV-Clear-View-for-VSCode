# Project hooks

Automation Claude Code runs for this repo, wired up in `../settings.json`.

| Hook | Event | What it does |
| --- | --- | --- |
| `block-vsix.mjs` | PreToolUse (Edit\|Write) | Refuses direct edits to `.vsix` build artifacts |
| `verify.mjs` | PostToolUse (Edit\|Write) | Type-checks and runs tests, for source files only |
| `graph.mjs` | PostToolUse + SessionStart | Updates / reports the `code-review-graph` index |

## Why these are node scripts, not shell one-liners

They have to work for everyone on the team — Claude Code in a terminal *and*
in the VS Code extension, on macOS, Linux, and Windows. Shell one-liners do
not survive that:

- **`jq` is not installed by default** on macOS or Windows, so a hook that
  parses its JSON payload with `jq` fails on a fresh machine.
- **Windows without Git Bash runs hooks under PowerShell**, where `tail`,
  `|| true`, `case…esac` and `${VAR:-default}` do not exist.
- **Node is guaranteed present** — it is required to build this extension at
  all — so it is the one interpreter every contributor already has.

The settings use the exec form (`"command": "node"` plus `"args"`), so nothing
passes through a shell parser on any platform.

## What triggers `verify.mjs`

The hook is gated so that editing a screenshot or a Markdown file costs nothing
(~26ms to decide and exit) while a real code change still gets checked.

| Edited path | Type-check | Tests |
| --- | --- | --- |
| `src/**/*.ts`, `tsconfig.json` | yes | yes |
| `media/*.js`, `media/*.css` | no | yes |
| `tests/*.js`, `webpack.config.js` | no | yes |
| `package.json`, `.vscodeignore`, `samples/valid_data.csv` | no | yes |
| anything else (docs, screenshots, other samples, these hooks) | no | no |

The non-obvious entries are deliberate: the test suite reads `media/csv.css`,
`.vscodeignore`, `package.json` and `samples/valid_data.csv` directly and
asserts against their contents, so those are **not** documentation and cannot
be skipped. **If you add a test that reads a new file, add it to `TESTED` in
`verify.mjs`** — otherwise editing that file will silently skip the test that
guards it.

When the payload carries no usable path, the hook runs everything rather than
guess. Better a wasted second than a missed regression.

## Conventions

- **Hooks run with the project root as the working directory**, so script
  paths and npm invocations are relative. `CLAUDE_PROJECT_DIR` is read only as
  a fallback. Do not hardcode absolute paths — an earlier version of
  `settings.json` did, and every hook silently failed for anyone whose
  checkout lived elsewhere.
- **Fail open, not closed.** A guard that errors on unexpected input must let
  the tool call through. `block-vsix.mjs` exits 0 on empty or malformed stdin;
  blocking on a parse error would have blocked every edit in the repo.
- **Optional tooling stays optional.** `code-review-graph` is a local install
  not everyone has, so `graph.mjs` always exits 0 and reports absence quietly.
- Exit code **2** blocks a tool call and reports the reason back; any other
  exit allows it.

## Testing a change

Pipe a synthetic payload straight into the script — this is exactly what
Claude Code sends:

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"/a/b.vsix"}}' \
  | node .claude/hooks/block-vsix.mjs; echo "exit=$?"   # expect 2

echo '{}' | node .claude/hooks/verify.mjs; echo "exit=$?"  # expect 0 when green
```

Check the exit code *and* the side effect. Then make a real edit to confirm
the hook fires in a live session.
