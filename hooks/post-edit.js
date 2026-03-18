#!/usr/bin/env node

/**
 * CrossWatch PostToolUse Hook — Record Action + Surface Awareness
 *
 * Fires after every successful Edit/Write/MultiEdit/Update.
 * 1. Records the completed action (with full diff for semantic analysis)
 * 2. Checks for collisions + pulls semantic analysis results
 * 3. Outputs collision info + semantic conflict analysis to stderr
 *
 * Bidirectional awareness:
 * - Agent B edits foo.ts → sees Agent A's task + semantic conflict analysis
 * - Agent A edits next  → sees Agent B's task + semantic conflict analysis
 */

const CROSSWATCH_URL = process.env.CROSSWATCH_URL || "http://localhost:7429";

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
  const toolName = input.tool_name || "edit";

  if (!filePath) {
    process.exit(0);
  }

  // Determine engineer identity
  let engineerId = process.env.CROSSWATCH_ENGINEER_ID || "unknown";
  if (engineerId === "unknown") {
    try {
      const { execSync } = require("child_process");
      engineerId = execSync("git config user.email 2>/dev/null", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim() || "unknown";
    } catch {}
  }

  // --- Step 1: Record the completed action ---

  let actionType = "edit";
  if (toolName === "Write" || toolName === "write") {
    actionType = toolInput.content && !toolInput.old_string ? "create" : "edit";
  }

  let summary = `${toolName} on ${filePath}`;
  let symbols = [];
  let detail = "";
  let diff = undefined;

  if (toolInput.old_string && toolInput.new_string) {
    const oldLen = toolInput.old_string.length;
    const newLen = toolInput.new_string.length;
    summary = `Edited ${filePath} (${oldLen} chars → ${newLen} chars)`;

    const fnMatch = toolInput.new_string.match(
      /(?:function|const|let|var|class|type|interface|export)\s+(\w+)/g
    );
    if (fnMatch) {
      symbols = fnMatch
        .map((m) => m.replace(/^(?:function|const|let|var|class|type|interface|export)\s+/, ""))
        .slice(0, 5);
      summary += ` [${symbols.join(", ")}]`;
    }

    // Send more context for semantic analysis (up to 1000 chars each)
    detail = toolInput.new_string.slice(0, 1000);
    diff = {
      old: toolInput.old_string.slice(0, 1000),
      new: toolInput.new_string.slice(0, 1000),
    };
  } else if (toolInput.content) {
    summary = `Wrote ${filePath} (${toolInput.content.length} chars)`;

    const fnMatch = toolInput.content.match(
      /(?:function|const|let|var|class|type|interface|export)\s+(\w+)/g
    );
    if (fnMatch) {
      symbols = fnMatch
        .map((m) => m.replace(/^(?:function|const|let|var|class|type|interface|export)\s+/, ""))
        .slice(0, 5);
      summary += ` [${symbols.join(", ")}]`;
    }

    detail = toolInput.content.slice(0, 1000);
  }

  try {
    // Check if server is reachable
    const healthRes = await fetch(`${CROSSWATCH_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!healthRes.ok) {
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }

  try {
    // Record the action (triggers async semantic analysis server-side)
    await fetch(`${CROSSWATCH_URL}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engineerId: engineerId,
        sessionId: sessionId,
        agentId: "claude-code",
        file: filePath,
        type: actionType,
        summary: summary,
        symbols: symbols,
        detail: detail,
        diff: diff,
      }),
      signal: AbortSignal.timeout(3000),
    });

    // --- Step 2: Check for collisions ---

    const awarenessRes = await fetch(
      `${CROSSWATCH_URL}/awareness/${sessionId}`,
      { signal: AbortSignal.timeout(2000) }
    );

    let awareness = null;
    if (awarenessRes.ok) {
      awareness = await awarenessRes.json();
    }

    // No collisions → nothing to report
    if (!awareness || !awareness.collisions || awareness.collisions.length === 0) {
      process.exit(0);
    }

    // --- Step 3: Fetch semantic analysis ---

    let analyses = [];
    try {
      const semRes = await fetch(
        `${CROSSWATCH_URL}/semantic/${sessionId}`,
        { signal: AbortSignal.timeout(2000) }
      );
      if (semRes.ok) {
        const semData = await semRes.json();
        analyses = semData.analyses || [];
      }
    } catch {}

    // --- Step 4: Build awareness output ---

    const lines = [];

    lines.push("⚡ CROSSWATCH: Other agents are also working on files you just edited.");
    lines.push("");

    // Group collisions by same-engineer vs other-engineer
    const sameEngineer = [];
    const otherEngineer = [];
    for (const collision of awareness.collisions) {
      for (const other of collision.overlapping) {
        const entry = { file: collision.file, totalAgents: collision.totalAgentsOnFile, other };
        if (other.engineerId && other.engineerId !== "unknown" && other.engineerId !== engineerId) {
          otherEngineer.push(entry);
        } else {
          sameEngineer.push(entry);
        }
      }
    }

    if (otherEngineer.length > 0) {
      lines.push("  OTHER ENGINEERS:");
      for (const e of otherEngineer) {
        const label = e.other.engineerId !== "unknown" ? ` [${e.other.engineerId}]` : "";
        lines.push(`    ${e.file} — ${e.other.agentId}${label} (${e.other.branch})`);
        if (e.other.sessionIntent) {
          lines.push(`      Task: ${e.other.sessionIntent}`);
        } else {
          lines.push(`      Intent: ${e.other.intent}`);
        }
        if (e.other.symbols && e.other.symbols.length > 0) {
          lines.push(`      Symbols: ${e.other.symbols.join(", ")}`);
        }
      }
      lines.push("");
    }

    if (sameEngineer.length > 0) {
      lines.push(otherEngineer.length > 0 ? "  YOUR OTHER SESSIONS:" : "  OVERLAPPING SESSIONS:");
      for (const e of sameEngineer) {
        lines.push(`    ${e.file} — ${e.other.agentId} (${e.other.branch})`);
        if (e.other.sessionIntent) {
          lines.push(`      Task: ${e.other.sessionIntent}`);
        } else {
          lines.push(`      Intent: ${e.other.intent}`);
        }
        if (e.other.symbols && e.other.symbols.length > 0) {
          lines.push(`      Symbols: ${e.other.symbols.join(", ")}`);
        }
      }
    }

    // Show semantic analysis results
    const conflicts = analyses.filter((a) => a.severity === "conflict");
    const potentials = analyses.filter((a) => a.severity === "potential-conflict");

    if (conflicts.length > 0) {
      lines.push("");
      lines.push("🚨 SEMANTIC CONFLICT DETECTED:");
      for (const c of conflicts) {
        lines.push(`  ${c.explanation}`);
      }
      lines.push("");
      lines.push(
        "STOP AND RECONSIDER. The changes described above are logically incompatible " +
          "with another agent's work. Continuing may produce broken code."
      );
    } else if (potentials.length > 0) {
      lines.push("");
      lines.push("⚠️  POTENTIAL CONFLICT:");
      for (const p of potentials) {
        lines.push(`  ${p.explanation}`);
      }
      lines.push("");
      lines.push(
        "Your edit went through. The changes above touch related code — " +
          "verify your approach is still valid."
      );
    } else {
      lines.push("");
      lines.push(
        "Your edit went through. No semantic conflicts detected, " +
          "but be aware other agents are active on these files."
      );
    }

    process.stderr.write(lines.join("\n") + "\n");

    // Exit 2 = inject stderr into agent context.
    // Only do this for actual conflicts/potential conflicts.
    // For compatible changes, exit 0 to avoid noise.
    if (conflicts.length > 0 || potentials.length > 0) {
      process.exit(2);
    }
  } catch {
    // Don't fail if CrossWatch has issues
  }

  process.exit(0);
}

main();
