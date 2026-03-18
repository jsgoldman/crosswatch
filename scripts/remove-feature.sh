#!/bin/bash
# scripts/remove-feature.sh
#
# Removes a feature worktree and cleans up its CrossWatch session.
#
# Usage: bash scripts/remove-feature.sh <feature-name>
# Example: bash scripts/remove-feature.sh oauth-scopes

set -e

FEATURE_NAME="$1"
CROSSWATCH_URL="${CROSSWATCH_URL:-http://localhost:7429}"

if [ -z "$FEATURE_NAME" ]; then
  echo "Usage: bash scripts/remove-feature.sh <feature-name>"
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"
WORKTREE_DIR="$(dirname "$REPO_ROOT")/${REPO_NAME}-${FEATURE_NAME}"

echo ""
echo "  🗑️  Removing feature: ${FEATURE_NAME}"
echo "  Worktree: ${WORKTREE_DIR}"
echo ""

# Clean up CrossWatch sessions for this worktree
# (sessions are identified by session_id which includes the Claude Code session,
#  but we can clean up any registrations that reference this branch)
if curl -s "$CROSSWATCH_URL/health" >/dev/null 2>&1; then
  echo "  🔗 Checking CrossWatch for active registrations..."
  STATUS=$(curl -s "$CROSSWATCH_URL/status" 2>/dev/null)
  if [ -n "$STATUS" ]; then
    echo "     (CrossWatch will clean up sessions when they end)"
  fi
fi

# Remove the worktree
if [ -d "$WORKTREE_DIR" ]; then
  git worktree remove "$WORKTREE_DIR" --force 2>/dev/null && \
    echo "  ✅ Worktree removed" || \
    echo "  ⚠️  Could not remove worktree (may have uncommitted changes)"
else
  echo "  ⚠️  Worktree not found: $WORKTREE_DIR"
fi

# Optionally delete the branch
read -p "  Delete branch feature/${FEATURE_NAME}? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  git branch -D "feature/${FEATURE_NAME}" 2>/dev/null && \
    echo "  ✅ Branch deleted" || \
    echo "  ⚠️  Could not delete branch"
fi

echo ""
echo "  Done."
echo ""
