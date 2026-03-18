#!/bin/bash
# scripts/morning-sync.sh
#
# Run this every morning before starting work.
# - Syncs all worktrees with main
# - Ensures CrossWatch hooks are installed in each
# - Checks if CrossWatch server is running
# - Shows collision status across all active branches

set -e

CROSSWATCH_DIR="${CROSSWATCH_HOME:-$HOME/tools/crosswatch}"
CROSSWATCH_URL="${CROSSWATCH_URL:-http://localhost:7429}"

echo ""
echo "  ☕ Morning sync"
echo "  ══════════════════════════════════════"
echo ""

# 1. Check CrossWatch server
echo "  🔍 CrossWatch server..."
if curl -s "$CROSSWATCH_URL/health" >/dev/null 2>&1; then
  echo "  ✅ Running on $CROSSWATCH_URL"
else
  echo "  ⚠️  NOT RUNNING. Starting it..."
  if [ -f "$CROSSWATCH_DIR/dist/index.js" ]; then
    cd "$CROSSWATCH_DIR" && node dist/index.js &
    sleep 2
    if curl -s "$CROSSWATCH_URL/health" >/dev/null 2>&1; then
      echo "  ✅ Started"
    else
      echo "  ❌ Failed to start. Run manually:"
      echo "      cd $CROSSWATCH_DIR && node dist/index.js"
    fi
  else
    echo "  ❌ CrossWatch not built. Run:"
    echo "      cd $CROSSWATCH_DIR && npm install && npx tsc"
  fi
fi
echo ""

# 2. Sync all worktrees
echo "  🔄 Syncing worktrees..."
echo ""

for dir in $(git worktree list --porcelain | grep "^worktree" | awk '{print $2}'); do
  BRANCH=$(git -C "$dir" branch --show-current 2>/dev/null || echo "detached")
  echo "  📁 $dir ($BRANCH)"

  # Sync with main
  git -C "$dir" fetch origin main 2>/dev/null
  if git -C "$dir" rebase origin/main 2>/dev/null; then
    echo "     ✅ Synced"
  else
    echo "     ⚠️  Rebase needs attention"
    git -C "$dir" rebase --abort 2>/dev/null
  fi

  # Ensure CrossWatch hooks are installed
  if [ -d "$CROSSWATCH_DIR/hooks" ]; then
    HOOK_DIR="$dir/.claude/hooks/crosswatch"
    if [ ! -f "$HOOK_DIR/pre-edit.js" ]; then
      echo "     🔗 Installing CrossWatch hooks..."
      mkdir -p "$HOOK_DIR"
      cp "$CROSSWATCH_DIR/hooks/pre-edit.js" "$HOOK_DIR/pre-edit.js"
      cp "$CROSSWATCH_DIR/hooks/post-edit.js" "$HOOK_DIR/post-edit.js"

      SETTINGS_FILE="$dir/.claude/settings.json"
      if [ ! -f "$SETTINGS_FILE" ]; then
        cp "$CROSSWATCH_DIR/hooks/settings.example.json" "$SETTINGS_FILE"
      fi
      echo "     ✅ Hooks installed"
    else
      # Update hook scripts in case they've changed
      cp "$CROSSWATCH_DIR/hooks/pre-edit.js" "$HOOK_DIR/pre-edit.js"
      cp "$CROSSWATCH_DIR/hooks/post-edit.js" "$HOOK_DIR/post-edit.js"
      echo "     ✅ Hooks up to date"
    fi
  fi

  echo ""
done

# 3. Show CrossWatch status if server is running
if curl -s "$CROSSWATCH_URL/health" >/dev/null 2>&1; then
  STATUS=$(curl -s "$CROSSWATCH_URL/status" 2>/dev/null)
  if [ -n "$STATUS" ]; then
    REGS=$(echo "$STATUS" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log('Registrations: '+j.totalRegistrations+', Sessions: '+j.totalSessions+', Collision files: '+(j.collisionFiles.length>0?j.collisionFiles.join(', '):'none'))" 2>/dev/null || echo "  (could not parse status)")
    echo "  📊 CrossWatch: $REGS"
  fi
fi

echo ""
echo "  ══════════════════════════════════════"
echo "  Ready. Open your worktree terminals and start claude."
echo ""
