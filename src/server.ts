/**
 * CrossWatch HTTP Server
 *
 * REST API + SSE. Supports N agents across M files.
 * Key endpoints:
 *   POST /register              Register files + get session-level awareness
 *   GET  /awareness/:session    Full collision graph for a session
 *   POST /action                Record an action to the live feed
 *   GET  /feed/session/:id      Session-level feed (all collision files)
 *   GET  /feed/file?file=...    Per-file feed
 *   GET  /stream/session/:id    SSE: real-time stream across all collisions
 *   GET  /stream/file?file=...  SSE: real-time stream for one file
 */

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import { Registry } from "./registry";
import { ActionFeed } from "./feed";
import { SemanticAnalyzer } from "./semantic";
import { RegisterInput, ActionInput } from "./types";

export function createServer(
  registry: Registry,
  feed: ActionFeed,
  analyzer: SemanticAnalyzer,
  port: number = 7429
) {
  const app = express();
  app.use(express.json());

  // ── Registration ──────────────────────────────────────────

  app.post("/register", (req, res) => {
    const input = req.body as RegisterInput;

    if (!input.agentId || !input.sessionId) {
      res.status(400).json({ error: "Required: agentId, sessionId" });
      return;
    }
    // Need either single file+intent or batch files
    const hasSingle = input.file && input.intent;
    const hasBatch = input.files && input.files.length > 0;
    if (!hasSingle && !hasBatch) {
      res.status(400).json({ error: "Provide file+intent or files[]" });
      return;
    }

    const result = registry.register(input);
    res.json(result);
  });

  // ── Awareness ─────────────────────────────────────────────

  app.get("/awareness/:sessionId", (req, res) => {
    const awareness = registry.getSessionAwareness(req.params.sessionId);
    res.json(awareness);
  });

  app.get("/check", (req, res) => {
    const file = req.query.file as string;
    if (!file) {
      res.status(400).json({ error: "Required: file" });
      return;
    }
    const collision = registry.checkFile(file, req.query.session as string);
    res.json({ collision });
  });

  // ── Session Intent ───────────────────────────────────────

  app.post("/session/:sessionId/intent", (req, res) => {
    const { intent } = req.body;
    if (!intent) {
      res.status(400).json({ error: "Required: intent" });
      return;
    }
    registry.setSessionIntent(req.params.sessionId, intent);
    res.json({ success: true, sessionId: req.params.sessionId });
  });

  app.get("/session/:sessionId/intent", (req, res) => {
    const intent = registry.getSessionIntent(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, intent: intent || null });
  });

  // ── Heartbeat ────────────────────────────────────────────

  app.post("/session/:sessionId/heartbeat", (req, res) => {
    registry.touch(req.params.sessionId);
    res.json({ success: true });
  });

  // ── Deregistration ────────────────────────────────────────

  app.delete("/register/:id", (req, res) => {
    res.json({ success: registry.deregister(req.params.id) });
  });

  app.delete("/session/:sessionId", (req, res) => {
    const regs = registry.deregisterSession(req.params.sessionId);
    const actions = feed.purgeSession(req.params.sessionId);
    analyzer.purgeSession(req.params.sessionId);
    res.json({ success: true, deregistered: regs, actionsPurged: actions });
  });

  // ── Action Feed ───────────────────────────────────────────

  app.post("/action", (req, res) => {
    const input = req.body as ActionInput;
    if (!input.sessionId || !input.agentId || !input.file || !input.type || !input.summary) {
      res.status(400).json({
        error: "Required: sessionId, agentId, file, type, summary",
      });
      return;
    }
    const action = feed.record(input);

    // Trigger async semantic analysis if there are collisions
    if (analyzer.isAvailable()) {
      const awareness = registry.getSessionAwareness(input.sessionId);
      if (awareness.collisions.length > 0) {
        // Analyze against each colliding session in the background
        for (const other of awareness.overlappingSessions) {
          const myActions = feed.query({ sessionId: input.sessionId, limit: 10 }).actions;
          const theirActions = feed.query({ sessionId: other.sessionId, limit: 10 }).actions;

          if (myActions.length > 0 && theirActions.length > 0) {
            analyzer.analyze(
              {
                sessionId: input.sessionId,
                agentId: input.agentId || "unknown",
                branch: registry.getSessionBranch(input.sessionId) || "unknown",
                intent: registry.getSessionIntent(input.sessionId),
                actions: myActions,
              },
              {
                sessionId: other.sessionId,
                agentId: other.agentId,
                branch: other.branch,
                intent: registry.getSessionIntent(other.sessionId),
                actions: theirActions,
              }
            ).catch((e) => console.error("[Semantic] Analysis failed:", e.message));
          }
        }
      }
    }

    res.json({ action });
  });

  // ── Semantic Analysis ───────────────────────────────────────

  /**
   * Get semantic analysis results for a session.
   * Returns cached analyses from the most recent LLM calls.
   */
  app.get("/semantic/:sessionId", (_req, res) => {
    const analyses = analyzer.getForSession(_req.params.sessionId);
    res.json({ analyses });
  });

  /** Debug: manually trigger analysis between two sessions */
  app.post("/semantic/test", async (req, res) => {
    const { sessionA, sessionB } = req.body;
    if (!sessionA || !sessionB) {
      res.status(400).json({ error: "Required: sessionA, sessionB" });
      return;
    }
    if (!analyzer.isAvailable()) {
      res.status(503).json({ error: "Semantic analyzer not available — ANTHROPIC_API_KEY not set" });
      return;
    }
    const actionsA = feed.query({ sessionId: sessionA, limit: 10 }).actions;
    const actionsB = feed.query({ sessionId: sessionB, limit: 10 }).actions;
    try {
      const result = await analyzer.analyze(
        {
          sessionId: sessionA,
          agentId: "claude-code",
          branch: registry.getSessionBranch(sessionA) || "unknown",
          intent: registry.getSessionIntent(sessionA),
          actions: actionsA,
        },
        {
          sessionId: sessionB,
          agentId: "claude-code",
          branch: registry.getSessionBranch(sessionB) || "unknown",
          intent: registry.getSessionIntent(sessionB),
          actions: actionsB,
        }
      );
      res.json({ result, actionsA: actionsA.length, actionsB: actionsB.length });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Session-level feed: all actions from other agents across ALL
   * files this session has collisions on. This is the primary
   * pull endpoint for agents — one call gives you everything.
   */
  app.get("/feed/session/:sessionId", (req, res) => {
    const afterSeq = req.query.after
      ? parseInt(req.query.after as string, 10)
      : undefined;
    res.json(feed.pullForSession(req.params.sessionId, afterSeq));
  });

  /**
   * Session-level formatted summary, ready for LLM context injection.
   */
  app.get("/feed/session/:sessionId/summary", (req, res) => {
    const afterSeq = req.query.after
      ? parseInt(req.query.after as string, 10)
      : undefined;
    res.type("text/plain").send(
      feed.summarizeForSession(req.params.sessionId, afterSeq)
    );
  });

  /** Per-file feed */
  app.get("/feed/file", (req, res) => {
    const file = req.query.file as string;
    if (!file) {
      res.status(400).json({ error: "Required: file" });
      return;
    }
    res.json(
      feed.query({
        file,
        excludeSession: req.query.session as string,
        afterSeq: req.query.after
          ? parseInt(req.query.after as string, 10)
          : undefined,
        limit: req.query.limit
          ? parseInt(req.query.limit as string, 10)
          : undefined,
      })
    );
  });

  /** Per-file formatted summary */
  app.get("/feed/file/summary", (req, res) => {
    const file = req.query.file as string;
    if (!file) {
      res.status(400).json({ error: "Required: file" });
      return;
    }
    res.type("text/plain").send(
      feed.summarizeForFile(
        file,
        req.query.session as string,
        req.query.after ? parseInt(req.query.after as string, 10) : undefined
      )
    );
  });

  // ── SSE Streams ───────────────────────────────────────────

  /**
   * Session-level SSE: real-time stream of ALL actions from other agents
   * across all collision files. One connection, full awareness.
   */
  app.get("/stream/session/:sessionId", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", sessionId: req.params.sessionId })}\n\n`);

    const unsub = feed.subscribeSession(req.params.sessionId, (action) => {
      res.write(`data: ${JSON.stringify(action)}\n\n`);
    });

    req.on("close", unsub);
  });

  /** Per-file SSE */
  app.get("/stream/file", (req, res) => {
    const file = req.query.file as string;
    const session = req.query.session as string;
    if (!file || !session) {
      res.status(400).json({ error: "Required: file, session" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", file })}\n\n`);

    const unsub = feed.subscribe(file, session, (action) => {
      res.write(`data: ${JSON.stringify(action)}\n\n`);
    });

    req.on("close", unsub);
  });

  // ── Dashboard ──────────────────────────────────────────────

  app.get("/dashboard", (_req, res) => {
    const html = readFileSync(join(__dirname, "dashboard.html"), "utf-8");
    res.type("html").send(html);
  });

  // ── Status ────────────────────────────────────────────────

  app.get("/status", (_req, res) => {
    res.json(registry.status());
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      semantic: {
        enabled: analyzer.isAvailable(),
        provider: analyzer.providerName(),
      },
      autoExpiry: {
        enabled: (parseInt(process.env.CROSSWATCH_SESSION_TTL || String(2 * 60 * 60 * 1000), 10)) > 0,
        ttlMinutes: Math.round(parseInt(process.env.CROSSWATCH_SESSION_TTL || String(2 * 60 * 60 * 1000), 10) / 60000),
        sweepMinutes: Math.round(parseInt(process.env.CROSSWATCH_SWEEP_INTERVAL || String(5 * 60 * 1000), 10) / 60000),
      },
      port,
    });
  });

  const server = app.listen(port, () => {
    console.log(`\n  CrossWatch running on http://localhost:${port}`);
    console.log(`  Dashboard: http://localhost:${port}/dashboard\n`);
    console.log(`  Registration & awareness:`);
    console.log(`    POST   /register                    Register + get awareness`);
    console.log(`    GET    /awareness/:session           Session collision graph`);
    console.log(`    GET    /check?file=...               Check one file`);
    console.log(`    DELETE /session/:id                   End session\n`);
    console.log(`  Live feed (polling):`);
    console.log(`    POST   /action                       Record an action`);
    console.log(`    GET    /feed/session/:id              All activity for session`);
    console.log(`    GET    /feed/session/:id/summary      LLM-ready summary`);
    console.log(`    GET    /feed/file?file=...            Activity on one file\n`);
    console.log(`  Live feed (streaming):`);
    console.log(`    GET    /stream/session/:id            SSE: all session activity`);
    console.log(`    GET    /stream/file?file=...          SSE: one file\n`);
  });

  return server;
}
