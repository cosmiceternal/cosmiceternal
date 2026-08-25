---
description: Review the working tree the way this project reviews changes
---
Review the current working-tree diff (`git diff` plus any untracked files).

Judge it against the rules in APOLLO.md, especially:
- every filesystem path goes through Workspace.resolve()
- tools return strings and throw Errors written for the model to act on
- preview() must not mutate
- anything touching message history works in both native and text tool modes

Focus on $ARGUMENTS.

Report each finding as `path:line` with one sentence on what breaks and one on
the fix. If the diff is clean, say so in a sentence — do not invent findings.
