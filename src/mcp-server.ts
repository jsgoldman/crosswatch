/**
 * CrossWatch MCP Server for Claude Code
 *
 * This is a stdio MCP server that Claude Code launches as a child process.
 * It bridges between Claude Code's MCP protocol and the CrossWatch HTTP API.
 *
 * Each Claude Code session gets a unique session ID. When the agent calls
 * crosswatch_register, it talks to the running CrossWatch server and gets
 * back awareness of other agents on the same files.
 *
 * Setup:
 *   1. Start the CrossWatch server:  node dist/index.js
 *   2. Add to Claude Code:
 *      claude mcp add crosswatch -- node /absolute/path/to/crosswatch/dist/mcp-server.js
 *
 * Or add to .claude.json / claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "crosswatch": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/crosswatch/dist/mcp-server.js"],
 *         "env": {
 *           "CROSSWATCH_URL": "http://localhost:7429",
 *           "CROSSWATCH_AGENT_ID": "claude-code",
 *           "CROSSWATCH_BRANCH": "main"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "crypto";

// ── Config ──────────────────────────────────────────────────────

const CROSSWATCH_URL = process.env.CROSSWATCH_URL || "http://localhost:7429";
const ENGINEER_ID = process.env.CROSSWATCH_ENGINEER_ID || "unknown";
const AGENT_ID = process.env.CROSSWATCH_AGENT_ID || "claude-code";
const SESSION_ID = `cc-${randomUUID().slice(0, 8)}`;
const BRANCH = process.env.CROSSWATCH_BRANCH || "unknown";

// Track cursor for incremental feed pulls
let lastCursor = 0;

// ── HTTP helpers ────────────────────────────────────────────────

async function postJSON(path: string, body: any): Promise<any> {
  const res = await fetch(`${CROSSWATCH_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CrossWatch ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getJSON(path: string): Promise<any> {
  const res = await fetch(`${CROSSWATCH_URL}${path}`);
  if (!res.ok) throw new Error(`CrossWatch ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getText(path: string): Promise<string> {
  const res = await fetch(`${CROSSWATCH_URL}${path}`);
  if (!res.ok) throw new Error(`CrossWatch ${path}: ${res.status} ${await res.text()}`);
  return res.text();
}

async function del(path: string): Promise<any> {
  const res = await fetch(`${CROSSWATCH_URL}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`CrossWatch ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── MCP Server ──────────────────────────────────────────────────

const server = new McpServer(
  {
    name: "crosswatch",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ── Tool: crosswatch_register ───────────────────────────────────

server.tool(
  "crosswatch_register",
  "Register your intent to modify one or more files and discover if any other agents are working on the same files. Call this BEFORE you modify a file. Returns awareness of all other agents across all your registered files. You decide whether their work affects your approach.",
  {
    file: z.string().optional().describe(
      "Single file path to register (relative to repo root). Use this OR files[], not both."
    ),
    symbols: z.array(z.string()).optional().describe(
      "Functions, types, exports, or class members you plan to modify in the single file."
    ),
    intent: z.string().optional().describe(
      "What you are doing and why, for the single file. 1-2 sentences."
    ),
    impact: z.string().optional().describe(
      "What changes for CONSUMERS of this code: new params, changed types, new exports."
    ),
    files: z
      .array(
        z.object({
          file: z.string().describe("File path relative to repo root"),
          symbols: z.array(z.string()).optional().describe("Symbols being modified"),
          intent: z.string().describe("What and why"),
          impact: z.string().optional().describe("Impact on consumers"),
        })
      )
      .optional()
      .describe(
        "Batch: register multiple files at once. Use this when you know you will touch several files."
      ),
  },
  async (args) => {
    try {
      const body: any = {
        engineerId: ENGINEER_ID,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        branch: BRANCH,
      };

      if (args.files && args.files.length > 0) {
        body.files = args.files;
      } else if (args.file && args.intent) {
        body.file = args.file;
        body.symbols = args.symbols || [];
        body.intent = args.intent;
        body.impact = args.impact || "";
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provide either file+intent (single) or files[] (batch).",
            },
          ],
        };
      }

      const result = await postJSON("/register", body);

      // Format awareness for the agent
      const awareness = result.awareness;
      const lines: string[] = [];

      if (awareness.collisions.length === 0) {
        lines.push(
          `Registered ${result.registrations.length} file(s). No other agents are working on these files.`
        );
      } else {
        lines.push(
          `Registered ${result.registrations.length} file(s). ` +
            `COLLISION DETECTED: ${awareness.collisions.length} file(s) have other agents.`
        );
        lines.push("");

        for (const collision of awareness.collisions) {
          lines.push(`--- ${collision.file} (${collision.totalAgentsOnFile} agents) ---`);
          for (const other of collision.overlapping) {
            lines.push(`  Agent: ${other.agentId} (branch: ${other.branch})`);
            if (other.symbols.length > 0) {
              lines.push(`  Symbols: ${other.symbols.join(", ")}`);
            }
            lines.push(`  Intent: ${other.intent}`);
            if (other.impact) {
              lines.push(`  Impact: ${other.impact}`);
            }
          }
          lines.push("");
        }

        lines.push(
          "Review the above and decide whether any of this affects your approach. " +
            "You may proceed as planned, adapt your changes, or flag this to the developer."
        );
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `CrossWatch server error: ${e.message}. Is the server running on ${CROSSWATCH_URL}?`,
          },
        ],
      };
    }
  }
);

// ── Tool: crosswatch_action ─────────────────────────────────────

server.tool(
  "crosswatch_action",
  "Record an action you just took. Call this AFTER modifying a file so other agents can see what you did in their live feed. Keep summaries concise.",
  {
    file: z.string().describe("The file you modified"),
    type: z
      .enum(["edit", "create", "delete", "rename", "test", "command", "decision", "note"])
      .describe("What kind of action"),
    summary: z.string().describe("What you did, in one sentence"),
    symbols: z.array(z.string()).optional().describe("Specific symbols affected"),
    detail: z.string().optional().describe("Optional: diff snippet, test result, or command output"),
  },
  async (args) => {
    try {
      await postJSON("/action", {
        engineerId: ENGINEER_ID,
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        file: args.file,
        type: args.type,
        summary: args.summary,
        symbols: args.symbols || [],
        detail: args.detail,
      });

      return {
        content: [{ type: "text" as const, text: "Action recorded." }],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to record action: ${e.message}`,
          },
        ],
      };
    }
  }
);

// ── Tool: crosswatch_pull ───────────────────────────────────────

server.tool(
  "crosswatch_pull",
  "Pull the live feed of actions from other agents on your collision files. Returns everything other agents have done since your last pull. Call this before making changes to see what has happened.",
  {},
  async () => {
    try {
      const summary = await getText(
        `/feed/session/${SESSION_ID}/summary?after=${lastCursor}`
      );

      // Get cursor from JSON endpoint to track position
      const feed = await getJSON(
        `/feed/session/${SESSION_ID}?after=${lastCursor}`
      );
      if (feed.cursor > lastCursor) {
        lastCursor = feed.cursor;
      }

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to pull feed: ${e.message}`,
          },
        ],
      };
    }
  }
);

// ── Tool: crosswatch_awareness ──────────────────────────────────

server.tool(
  "crosswatch_awareness",
  "Get your full collision picture: every file you have registered that has other agents, and who those agents are. Use this to get a high-level view of all overlapping work.",
  {},
  async () => {
    try {
      const awareness = await getJSON(`/awareness/${SESSION_ID}`);

      if (awareness.collisions.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `You are registered on ${awareness.sessionFiles} file(s). No collisions with other agents.`,
            },
          ],
        };
      }

      const lines: string[] = [
        `Registered on ${awareness.sessionFiles} file(s). ` +
          `${awareness.collisions.length} file(s) have other agents. ` +
          `${awareness.uniqueOverlappingSessions} other session(s) overlap with your work.`,
        "",
      ];

      for (const collision of awareness.collisions) {
        lines.push(`--- ${collision.file} (${collision.totalAgentsOnFile} agents) ---`);
        for (const other of collision.overlapping) {
          lines.push(`  ${other.agentId} (${other.branch}): ${other.intent}`);
        }
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to get awareness: ${e.message}`,
          },
        ],
      };
    }
  }
);

// ── Tool: crosswatch_done ───────────────────────────────────────

server.tool(
  "crosswatch_done",
  "Signal that your session is complete. Removes all your registrations and cleans up. Call when your work is finished or your branch has merged.",
  {},
  async () => {
    try {
      const result = await del(`/session/${SESSION_ID}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Session ended. Removed ${result.deregistered} registration(s) and ${result.actionsPurged} action(s).`,
          },
        ],
      };
    } catch (e: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to end session: ${e.message}`,
          },
        ],
      };
    }
  }
);

// ── Start ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Heartbeat to prevent auto-expiry while session is alive
  const heartbeatInterval = setInterval(async () => {
    try {
      await postJSON(`/session/${SESSION_ID}/heartbeat`, {});
    } catch {}
  }, 60_000);
  heartbeatInterval.unref();

  // Log to stderr (stdout is for MCP protocol)
  process.stderr.write(
    `CrossWatch MCP server started (session: ${SESSION_ID}, agent: ${AGENT_ID}, engineer: ${ENGINEER_ID})\n`
  );
}

main().catch((e) => {
  process.stderr.write(`CrossWatch MCP server error: ${e.message}\n`);
  process.exit(1);
});
