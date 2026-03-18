#!/usr/bin/env node

/**
 * CrossWatch PreToolUse Hook — Register Intent
 *
 * Fires before every Edit/Write/MultiEdit/Update.
 * 1. Reads the first user message from the transcript (cached per session)
 *    and registers it as the session's high-level task intent
 * 2. Registers the specific file + edit intent with CrossWatch
 *
 * No output, no blocking — just registration. Awareness output
 * happens in post-edit.js (PostToolUse).
 */

const CROSSWATCH_URL = process.env.CROSSWATCH_URL || "http://localhost:7429";

/**
 * Extract the first user message from a Claude Code JSONL transcript.
 * This is the task the user asked the agent to do — the best high-level
 * description of what this agent is working on.
 */
function extractFirstUserMessage(transcriptPath) {
  try {
    const fs = require("fs");
    const content = fs.readFileSync(transcriptPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.type !== "user") continue;

      const msg = obj.message;
      if (!msg) continue;

      // Message content can be a string or { content: [...] }
      if (typeof msg === "string") return msg.slice(0, 500);

      const msgContent = msg.content;
      if (typeof msgContent === "string") return msgContent.slice(0, 500);

      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block && block.type === "text" && block.text) {
            return block.text.slice(0, 500);
          }
        }
      }
    }
  } catch {
    // Can't read transcript — not fatal
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || "";
  const sessionId = input.session_id || "unknown-session";
  const transcriptPath = input.transcript_path || "";

  if (!filePath) {
    process.exit(0);
  }

  // Determine branch and engineer identity from git
  let branch = "unknown";
  let engineerId = process.env.CROSSWATCH_ENGINEER_ID || "unknown";
  try {
    const { execSync } = require("child_process");
    branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (engineerId === "unknown") {
      engineerId = execSync("git config user.email 2>/dev/null", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim() || "unknown";
    }
  } catch {}

  // Build per-edit intent from the tool input
  const toolName = input.tool_name || "edit";
  let intent = `${toolName} on ${filePath}`;
  let symbols = [];

  if (toolInput.new_string || toolInput.content) {
    const content = toolInput.new_string || toolInput.content || "";
    const fnMatch = content.match(
      /(?:function|const|let|var|class|type|interface|export)\s+(\w+)/g
    );
    if (fnMatch) {
      symbols = fnMatch
        .map((m) => m.replace(/^(?:function|const|let|var|class|type|interface|export)\s+/, ""))
        .slice(0, 5);
    }
  }

  if (toolInput.old_string && toolInput.new_string) {
    intent = `Replacing code in ${filePath}`;
    if (symbols.length > 0) {
      intent += ` (touching: ${symbols.join(", ")})`;
    }
  } else if (toolInput.content) {
    intent = `Writing ${filePath}`;
    if (symbols.length > 0) {
      intent += ` (defines: ${symbols.join(", ")})`;
    }
  }

  try {
    // Register session intent (first user message) — server stores only the first one
    if (transcriptPath) {
      const sessionIntent = extractFirstUserMessage(transcriptPath);
      if (sessionIntent) {
        await fetch(`${CROSSWATCH_URL}/session/${sessionId}/intent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent: sessionIntent }),
          signal: AbortSignal.timeout(1000),
        }).catch(() => {});
      }
    }

    // Register the file + per-edit intent
    await fetch(`${CROSSWATCH_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engineerId: engineerId,
        agentId: "claude-code",
        sessionId: sessionId,
        branch: branch,
        file: filePath,
        symbols: symbols,
        intent: intent,
        impact: "",
      }),
      signal: AbortSignal.timeout(2000),
    });

    // Check for cached semantic conflicts — block if critical
    try {
      const semRes = await fetch(
        `${CROSSWATCH_URL}/semantic/${sessionId}`,
        { signal: AbortSignal.timeout(1000) }
      );
      if (semRes.ok) {
        const semData = await semRes.json();
        const conflicts = (semData.analyses || []).filter(
          (a) => a.severity === "conflict"
        );
        if (conflicts.length > 0) {
          process.stderr.write(
            "🚨 CROSSWATCH — SEMANTIC CONFLICT: Another agent's recent changes " +
              "are logically incompatible with your work.\n\n" +
              conflicts.map((c) => `  ${c.explanation}`).join("\n") +
              "\n\nSTOP. Re-read the other agent's changes before proceeding. " +
              "Your planned edit may produce broken code.\n"
          );
          process.exit(2); // Block the edit
        }
      }
    } catch {}
  } catch {
    // Server unreachable — don't block
  }

  process.exit(0);
}

main();
