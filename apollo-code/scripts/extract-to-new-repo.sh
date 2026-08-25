#!/usr/bin/env bash
#
# Lift apollo-code/ out of its host repository into a standalone git repo.
#
#   1. Create an empty repo on GitHub (no README, no .gitignore, no license).
#   2. ./scripts/extract-to-new-repo.sh git@github.com:you/apollo-code.git
#
# The result is a fresh repository whose root is this directory, with a single
# initial commit. The host repo is left untouched.

set -euo pipefail

REMOTE="${1:-}"
if [ -z "$REMOTE" ]; then
  echo "usage: $0 <git-remote-url> [target-dir]" >&2
  echo "example: $0 git@github.com:you/apollo-code.git" >&2
  exit 2
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${2:-$(dirname "$SOURCE_DIR")/apollo-code-standalone}"

if [ -e "$TARGET" ]; then
  echo "error: $TARGET already exists — remove it or pass a different target" >&2
  exit 1
fi

echo "→ copying $SOURCE_DIR to $TARGET"
mkdir -p "$TARGET"
# Copy tracked content only; skip local state and any node_modules.
(cd "$SOURCE_DIR" && tar --exclude='./node_modules' --exclude='./.apollo/sessions' \
                        --exclude='./.git' -cf - .) | (cd "$TARGET" && tar -xf -)

cd "$TARGET"
git init -q -b main
git add -A
git commit -q -m "Apollo: an offline coding agent CLI

A Claude Code-style agent loop driven by a local LLM. Supports Ollama and
OpenAI-compatible servers, native and text-protocol tool calling, a workspace
path jail, permission modes, context compaction and resumable sessions.
Zero runtime dependencies."

git remote add origin "$REMOTE"
echo
echo "✓ standalone repo ready at $TARGET"
echo "  next:  cd $TARGET && git push -u origin main"
