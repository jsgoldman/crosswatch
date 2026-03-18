/**
 * CrossWatch Demo — 5 agents, complex collision graph
 *
 * Simulates one developer running 5 agent sessions in parallel.
 * Collisions form a graph across multiple files.
 */

const BASE = process.env.CROSSWATCH_URL || "http://localhost:7429";

async function post(path: string, body: any): Promise<any> {
  return (await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json() as any;
}
async function get(path: string): Promise<any> {
  return (await fetch(`${BASE}${path}`)).json() as any;
}
async function getText(path: string): Promise<string> {
  return (await fetch(`${BASE}${path}`)).text();
}
function div(label: string) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ${label}`);
  console.log(`${"=".repeat(64)}\n`);
}
function pause(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function demo() {
  div("5 AGENTS, 6 FILES, COMPLEX COLLISION GRAPH");

  // ── Register 5 agents with batch file registration ──────────

  div("Phase 1: 5 agents register (batch mode)");

  // Agent 1: OAuth feature — touches auth.ts and user.ts
  const r1 = await post("/register", {
    agentId: "claude-1", sessionId: "sess-oauth", branch: "feature/oauth",
    files: [
      { file: "src/services/auth.ts", symbols: ["refreshToken", "TokenResponse"],
        intent: "Adding OAuth scope validation to refreshToken()",
        impact: "refreshToken() gains required OAuthScope param" },
      { file: "src/models/user.ts", symbols: ["User", "UserPermissions"],
        intent: "Adding scopes field to User model for OAuth permissions",
        impact: "User type gets new required scopes: string[] field" },
    ]
  });
  console.log(`Agent 1 (oauth): registered 2 files, ${r1.awareness.collisions.length} collisions`);

  // Agent 2: Error handling — touches auth.ts and api-client.ts
  const r2 = await post("/register", {
    agentId: "claude-2", sessionId: "sess-errors", branch: "feature/error-handling",
    files: [
      { file: "src/services/auth.ts", symbols: ["refreshToken", "handleAuthError"],
        intent: "Refactoring error handling with centralized handleAuthError()",
        impact: "All error paths in auth module change" },
      { file: "src/lib/api-client.ts", symbols: ["ApiClient", "retryRequest"],
        intent: "Adding retry logic to ApiClient for transient failures",
        impact: "ApiClient gains configurable retry behavior" },
    ]
  });
  console.log(`Agent 2 (errors): registered 2 files, ${r2.awareness.collisions.length} collision(s)`);
  if (r2.awareness.collisions.length > 0) {
    for (const c of r2.awareness.collisions) {
      console.log(`  collision on ${c.file}: ${c.totalAgentsOnFile} agents`);
    }
  }

  // Agent 3: User profile feature — touches user.ts and api-client.ts
  const r3 = await post("/register", {
    agentId: "cursor-1", sessionId: "sess-profile", branch: "feature/user-profile",
    files: [
      { file: "src/models/user.ts", symbols: ["User", "UserProfile"],
        intent: "Extending User model with profile fields (avatar, bio, social links)",
        impact: "User type gets 4 new optional fields" },
      { file: "src/lib/api-client.ts", symbols: ["ApiClient"],
        intent: "Adding file upload support to ApiClient for avatar uploads",
        impact: "ApiClient gains uploadFile() method" },
    ]
  });
  console.log(`Agent 3 (profile): registered 2 files, ${r3.awareness.collisions.length} collision(s)`);
  for (const c of r3.awareness.collisions) {
    console.log(`  collision on ${c.file}: ${c.totalAgentsOnFile} agents`);
  }

  // Agent 4: Payment integration — touches payments.ts and api-client.ts
  const r4 = await post("/register", {
    agentId: "aider-1", sessionId: "sess-payments", branch: "feature/payments",
    files: [
      { file: "src/services/payments.ts", symbols: ["processPayment", "PaymentResult"],
        intent: "Adding Stripe webhook handling for async payment confirmation",
        impact: "processPayment becomes async, new webhook endpoint" },
      { file: "src/lib/api-client.ts", symbols: ["ApiClient", "setWebhookHeaders"],
        intent: "Adding webhook signature verification to ApiClient",
        impact: "ApiClient gains webhook header validation" },
    ]
  });
  console.log(`Agent 4 (payments): registered 2 files, ${r4.awareness.collisions.length} collision(s)`);
  for (const c of r4.awareness.collisions) {
    console.log(`  collision on ${c.file}: ${c.totalAgentsOnFile} agents`);
  }

  // Agent 5: Notifications — touches user.ts and a clean file
  const r5 = await post("/register", {
    agentId: "copilot-1", sessionId: "sess-notifs", branch: "feature/notifications",
    files: [
      { file: "src/models/user.ts", symbols: ["User", "NotificationPrefs"],
        intent: "Adding notification preferences to User model",
        impact: "User type gets notificationPrefs field" },
      { file: "src/services/notifications.ts", symbols: ["sendNotification"],
        intent: "Building notification service from scratch",
        impact: "New module, no existing dependencies" },
    ]
  });
  console.log(`Agent 5 (notifs): registered 2 files, ${r5.awareness.collisions.length} collision(s)`);
  for (const c of r5.awareness.collisions) {
    console.log(`  collision on ${c.file}: ${c.totalAgentsOnFile} agents`);
  }

  // ── Show the full collision graph ───────────────────────────

  div("Phase 2: The collision graph");

  const status = await get("/status");
  console.log(`Total registrations: ${status.totalRegistrations}`);
  console.log(`Total files: ${status.totalFiles}`);
  console.log(`Total sessions: ${status.totalSessions}`);
  console.log(`Collision files: ${status.collisionFiles.length}\n`);

  for (const edge of status.collisionGraph) {
    const agents = edge.sessions.map((s: any) => `${s.agentId}/${s.branch}`).join(", ");
    console.log(`  ${edge.file}`);
    console.log(`    agents: ${agents}\n`);
  }

  // ── Session-level awareness ─────────────────────────────────

  div("Phase 3: Session-level awareness (Agent 3's full picture)");
  console.log("Agent 3 (user-profile) touches user.ts and api-client.ts.");
  console.log("Let's see its FULL collision picture:\n");

  const awareness3 = await get("/awareness/sess-profile");
  console.log(`Files registered: ${awareness3.sessionFiles}`);
  console.log(`Files with collisions: ${awareness3.collisions.length}`);
  console.log(`Unique overlapping sessions: ${awareness3.uniqueOverlappingSessions}\n`);

  console.log("Collisions by file:");
  for (const c of awareness3.collisions) {
    console.log(`\n  ${c.file} (${c.totalAgentsOnFile} agents):`);
    for (const o of c.overlapping) {
      console.log(`    ${o.agentId} (${o.branch}): ${o.intent}`);
    }
  }

  console.log("\nOverlapping sessions (de-duped):");
  for (const s of awareness3.overlappingSessions) {
    console.log(`  ${s.agentId} (${s.branch}): shares ${s.sharedFiles.join(", ")}`);
    console.log(`    (working on ${s.totalFiles} files total)`);
  }

  // ── Live feed across multiple files ─────────────────────────

  div("Phase 4: Actions stream in — multiple agents working");

  // Agent 1 makes changes to auth.ts
  await post("/action", {
    sessionId: "sess-oauth", agentId: "claude-1",
    file: "src/services/auth.ts", type: "edit",
    summary: "Added OAuthScope enum and guard clause to refreshToken()",
    symbols: ["refreshToken", "OAuthScope"],
  });
  console.log("  [Agent 1/oauth] edit auth.ts: Added OAuthScope + guard clause");

  // Agent 1 makes changes to user.ts
  await post("/action", {
    sessionId: "sess-oauth", agentId: "claude-1",
    file: "src/models/user.ts", type: "edit",
    summary: "Added scopes: OAuthScope[] to User interface",
    symbols: ["User"],
  });
  console.log("  [Agent 1/oauth] edit user.ts: Added scopes to User");

  // Agent 3 makes changes to api-client.ts
  await post("/action", {
    sessionId: "sess-profile", agentId: "cursor-1",
    file: "src/lib/api-client.ts", type: "edit",
    summary: "Added uploadFile() method to ApiClient with multipart form support",
    symbols: ["ApiClient", "uploadFile"],
  });
  console.log("  [Agent 3/profile] edit api-client.ts: Added uploadFile()");

  // Agent 4 makes changes to api-client.ts
  await post("/action", {
    sessionId: "sess-payments", agentId: "aider-1",
    file: "src/lib/api-client.ts", type: "edit",
    summary: "Added setWebhookHeaders() for Stripe signature verification",
    symbols: ["ApiClient", "setWebhookHeaders"],
  });
  console.log("  [Agent 4/payments] edit api-client.ts: Added webhook headers");

  // Agent 5 makes changes to user.ts
  await post("/action", {
    sessionId: "sess-notifs", agentId: "copilot-1",
    file: "src/models/user.ts", type: "edit",
    summary: "Added NotificationPrefs type and notificationPrefs field to User",
    symbols: ["User", "NotificationPrefs"],
  });
  console.log("  [Agent 5/notifs] edit user.ts: Added notification prefs to User");

  await pause(100);

  // ── Session-level feed pull ─────────────────────────────────

  div("Phase 5: Agent 3 pulls session-level feed");
  console.log("Agent 3 makes ONE call and gets ALL activity across both");
  console.log("its collision files (user.ts AND api-client.ts):\n");

  const summary3 = await getText("/feed/session/sess-profile/summary");
  console.log(summary3);

  // ── Agent 2's view: different collision surface ─────────────

  div("Phase 6: Agent 2 pulls its session-level feed");
  console.log("Agent 2 (error-handling) collides on auth.ts and api-client.ts.");
  console.log("Completely different collision surface from Agent 3:\n");

  const summary2 = await getText("/feed/session/sess-errors/summary");
  console.log(summary2);

  // ── Final status ────────────────────────────────────────────

  div("Result");
  console.log("5 agents, 6 files, complex collision graph.");
  console.log("Each agent gets a COMPLETE view of all intersecting work.");
  console.log("One pull call per agent, regardless of how many files collide.");
  console.log("The LLMs decide what matters. The system just connects them.\n");

  console.log("Collision graph:");
  console.log("  auth.ts:       Agent 1 (oauth) <-> Agent 2 (errors)");
  console.log("  user.ts:       Agent 1 (oauth) <-> Agent 3 (profile) <-> Agent 5 (notifs)");
  console.log("  api-client.ts: Agent 2 (errors) <-> Agent 3 (profile) <-> Agent 4 (payments)");
  console.log("  payments.ts:   Agent 4 only (no collision)");
  console.log("  notifications.ts: Agent 5 only (no collision)\n");
}

demo().catch(console.error);
