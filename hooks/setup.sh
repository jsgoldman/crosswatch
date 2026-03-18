#!/bin/bash

# CrossWatch Hook Installer
#
# Run this from your project root (or any git worktree root).
# It copies the hook scripts and configures .claude/settings.json.
#
# Usage:
#   bash /path/to/crosswatch/hooks/setup.sh
#
# What it does:
#   1. Creates .claude/hooks/crosswatch/ in your project
#   2. Copies pre-edit.js and post-edit.js there
#   3. Creates or merges hooks into .claude/settings.json
#   4. Tells you how to start the CrossWatch server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${1:-.}"

echo ""
echo "  CrossWatch Hook Installer"
echo "  ========================="
echo ""

# Resolve project dir
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
echo "  Project: $PROJECT_DIR"

# Create hook directory
HOOK_DIR="$PROJECT_DIR/.claude/hooks/crosswatch"
mkdir -p "$HOOK_DIR"

# Copy hook scripts
cp "$SCRIPT_DIR/pre-edit.js" "$HOOK_DIR/pre-edit.js"
cp "$SCRIPT_DIR/post-edit.js" "$HOOK_DIR/post-edit.js"
echo "  Hooks copied to $HOOK_DIR"

# Handle settings.json
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  # Check if hooks are already configured
  if grep -q "crosswatch" "$SETTINGS_FILE" 2>/dev/null; then
    echo "  Settings already contain crosswatch hooks. Skipping merge."
    echo ""
    echo "  ✓ Done. Hook scripts updated."
  else
    echo ""
    echo "  ⚠ Existing .claude/settings.json found."
    echo "  You need to manually add the hooks from:"
    echo "    $SCRIPT_DIR/settings.example.json"
    echo ""
    echo "  Add this to your existing 'hooks' section:"
    echo ""
    echo '    "PreToolUse": ['
    echo '      {'
    echo '        "matcher": "Edit|Write|MultiEdit",'
    echo '        "hooks": [{'
    echo '          "type": "command",'
    echo '          "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/crosswatch/pre-edit.js\"",'
    echo '          "timeout": 5'
    echo '        }]'
    echo '      }'
    echo '    ],'
    echo '    "PostToolUse": ['
    echo '      {'
    echo '        "matcher": "Edit|Write|MultiEdit",'
    echo '        "hooks": [{'
    echo '          "type": "command",'
    echo '          "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/crosswatch/post-edit.js\"",'
    echo '          "timeout": 3'
    echo '        }]'
    echo '      }'
    echo '    ]'
    echo ""
  fi
else
  # Create fresh settings.json
  mkdir -p "$PROJECT_DIR/.claude"
  cp "$SCRIPT_DIR/settings.example.json" "$SETTINGS_FILE"
  echo "  Created $SETTINGS_FILE"
  echo ""
  echo "  ✓ Done. Hooks are configured."
fi

echo ""
echo "  Next steps:"
echo "    1. Start the CrossWatch server:"
echo "       cd /path/to/crosswatch && node dist/index.js"
echo ""
echo "    2. Start Claude Code in your project."
echo "       Every Edit/Write will now auto-register with CrossWatch."
echo ""
echo "    3. Start a second Claude Code session (another worktree/branch)."
echo "       When both agents touch the same file, they'll see each other."
echo ""
echo "  The CROSSWATCH_URL env var defaults to http://localhost:7429"
echo "  Set it in your shell if the server runs elsewhere."
echo ""
