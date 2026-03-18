import { config } from "dotenv";
config();

import { Registry } from "./registry";
import { ActionFeed } from "./feed";
import { SemanticAnalyzer } from "./semantic";
import { createServer } from "./server";

const port = parseInt(process.env.CROSSWATCH_PORT || "7429", 10);
const registry = new Registry();
const analyzer = new SemanticAnalyzer();
const feed = new ActionFeed(registry);
createServer(registry, feed, analyzer, port);

if (analyzer.isAvailable()) {
  console.log(`  Semantic analysis: enabled (${analyzer.providerName()})`);
} else {
  console.log("  Semantic analysis: disabled (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY to enable)");
}

// ── Auto-expiry ──────────────────────────────────────────────
// Sweep idle sessions periodically. Configurable via env vars.
// Set CROSSWATCH_SESSION_TTL=0 to disable.

const SESSION_TTL_MS = parseInt(
  process.env.CROSSWATCH_SESSION_TTL || String(2 * 60 * 60 * 1000), // default 2 hours
  10
);
const SWEEP_INTERVAL_MS = parseInt(
  process.env.CROSSWATCH_SWEEP_INTERVAL || String(5 * 60 * 1000), // default 5 minutes
  10
);

if (SESSION_TTL_MS > 0) {
  const sweepTimer = setInterval(() => {
    const expired = registry.getExpiredSessions(SESSION_TTL_MS);
    for (const sessionId of expired) {
      const regs = registry.deregisterSession(sessionId);
      const actions = feed.purgeSession(sessionId);
      analyzer.purgeSession(sessionId);
      if (regs > 0 || actions > 0) {
        console.log(
          `  [AutoExpiry] Purged session ${sessionId}: ` +
          `${regs} registration(s), ${actions} action(s)`
        );
      }
    }
  }, SWEEP_INTERVAL_MS);

  sweepTimer.unref(); // Don't prevent process exit

  console.log(
    `  Session auto-expiry: ${SESSION_TTL_MS / 1000 / 60}m TTL, ` +
    `sweep every ${SWEEP_INTERVAL_MS / 1000 / 60}m`
  );
} else {
  console.log("  Session auto-expiry: disabled");
}
