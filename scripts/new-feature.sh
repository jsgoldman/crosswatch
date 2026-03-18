#!/bin/bash
# scripts/new-feature.sh
#
# Creates a new feature worktree with everything wired up:
# - Git worktree
# - CLAUDE.md from WORKER.md template
# - npm install
# - CrossWatch hooks installed
#
# Usage: bash scripts/new-feature.sh <feature-name>
# Example: bash scripts/new-feature.sh oauth-scopes
#
# Creates: ../<repo-name>-oauth-scopes on branch feature/oauth-scopes

set -e

FEATURE_NAME="$1"
if [ -z "$FEATURE_NAME" ]; then
  echo "Usage: bash scripts/new-feature.sh <feature-name>"
  echo "Example: bash scripts/new-feature.sh oauth-scopes"
  exit 1
fi

# Paths
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"
WORKTREE_DIR="$(dirname "$REPO_ROOT")/${REPO_NAME}-${FEATURE_NAME}"
BRANCH_NAME="feature/${FEATURE_NAME}"
CROSSWATCH_DIR="${CROSSWATCH_HOME:-$HOME/tools/crosswatch}"

echo ""
echo "  🚀 Creating feature: ${FEATURE_NAME}"
echo "  ══════════════════════════════════════"
echo "  Worktree: ${WORKTREE_DIR}"
echo "  Branch:   ${BRANCH_NAME}"
echo ""

# 1. Create worktree
if [ -d "$WORKTREE_DIR" ]; then
  echo "  ⚠️  Worktree already exists: $WORKTREE_DIR"
  exit 1
fi

echo "  📁 Creating worktree..."
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" 2>/dev/null || \
  git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"
echo "  ✅ Worktree created"

# 2. Copy WORKER.md as CLAUDE.md
if [ -f "$REPO_ROOT/WORKER.md" ]; then
  cp "$REPO_ROOT/WORKER.md" "$WORKTREE_DIR/CLAUDE.md"
  echo "  ✅ CLAUDE.md copied from WORKER.md"
elif [ -f "$REPO_ROOT/claude.md" ]; then
  cp "$REPO_ROOT/claude.md" "$WORKTREE_DIR/CLAUDE.md"
  echo "  ✅ CLAUDE.md copied"
fi

# 3. Install dependencies
echo "  📦 Installing dependencies..."
cd "$WORKTREE_DIR"
npm install --silent 2>/dev/null && echo "  ✅ npm install complete" || echo "  ⚠️  npm install had issues (non-fatal)"

# 4. Install CrossWatch hooks
if [ -d "$CROSSWATCH_DIR/hooks" ]; then
  echo "  🔗 Installing CrossWatch hooks..."

  # Create hooks directory
  mkdir -p "$WORKTREE_DIR/.claude/hooks/crosswatch"
  cp "$CROSSWATCH_DIR/hooks/pre-edit.js" "$WORKTREE_DIR/.claude/hooks/crosswatch/pre-edit.js"
  cp "$CROSSWATCH_DIR/hooks/post-edit.js" "$WORKTREE_DIR/.claude/hooks/crosswatch/post-edit.js"

  # Create or merge settings.json
  SETTINGS_FILE="$WORKTREE_DIR/.claude/settings.json"
  if [ ! -f "$SETTINGS_FILE" ]; then
    cp "$CROSSWATCH_DIR/hooks/settings.example.json" "$SETTINGS_FILE"
    echo "  ✅ CrossWatch hooks installed + settings.json created"
  else
    if grep -q "crosswatch" "$SETTINGS_FILE" 2>/dev/null; then
      echo "  ✅ CrossWatch hooks already in settings.json"
    else
      echo "  ⚠️  settings.json exists — add CrossWatch hooks manually"
      echo "      See: $CROSSWATCH_DIR/hooks/settings.example.json"
    fi
    # Still update the hook scripts
    echo "  ✅ CrossWatch hook scripts updated"
  fi

  # Check if server is running
  if curl -s http://localhost:7429/health >/dev/null 2>&1; then
    echo "  ✅ CrossWatch server is running"
  else
    echo "  ⚠️  CrossWatch server not running. Start it:"
    echo "      cd $CROSSWATCH_DIR && node dist/index.js"
  fi
else
  echo "  ⚠️  CrossWatch not found at $CROSSWATCH_DIR"
  echo "      Set CROSSWATCH_HOME or install to ~/tools/crosswatch"
  echo "      Hooks NOT installed — agents won't have collision detection"
fi

# 5. Sync with main
echo "  🔄 Syncing with main..."
git fetch origin main 2>/dev/null
git rebase origin/main 2>/dev/null && echo "  ✅ Rebased onto main" || echo "  ⚠️  Rebase had issues"

echo ""
echo "  ══════════════════════════════════════"
echo "  ✅ Ready! To start working:"
echo ""
echo "    cd $WORKTREE_DIR && claude"
echo ""
echo "  CrossWatch will automatically detect collisions"
echo "  with other active worktree sessions."
echo "  ══════════════════════════════════════"
echo ""
