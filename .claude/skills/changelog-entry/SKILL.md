---
name: changelog-entry
description: Draft a new CHANGELOG.md entry for the next version from recent git commits
disable-model-invocation: true
---

1. Run `git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD` to get commits since last tag
2. Read CHANGELOG.md to see the current format and latest version
3. Draft a new version entry following the existing style
4. Ask the user to confirm the version number before writing
5. Prepend the new entry to CHANGELOG.md
