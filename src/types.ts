/**
 * CrossWatch - Core Types
 *
 * Designed for N agents across M files. Collisions form a graph:
 * any agent can collide with any number of other agents across
 * any number of files. The awareness model gives each agent a
 * complete picture of every intersection with their work.
 */

// ── Registration ──────────────────────────────────────────────

export interface Registration {
  id: string;
  engineerId: string;
  agentId: string;
  sessionId: string;
  file: string;
  symbols: string[];
  intent: string;
  impact: string;
  branch: string;
  timestamp: string;
}

export interface FileIntent {
  file: string;
  symbols?: string[];
  intent: string;
  impact?: string;
}

export interface RegisterInput {
  engineerId?: string;
  agentId: string;
  sessionId: string;
  branch?: string;
  /** Single file */
  file?: string;
  symbols?: string[];
  intent?: string;
  impact?: string;
  /** Batch: multiple files at once */
  files?: FileIntent[];
}

// ── Awareness ─────────────────────────────────────────────────

export interface OverlappingAgent {
  engineerId: string;
  agentId: string;
  sessionId: string;
  branch: string;
  symbols: string[];
  intent: string;
  impact: string;
  registeredAt: string;
  /** High-level task description from the agent's first user message */
  sessionIntent?: string;
}

export interface FileCollision {
  file: string;
  overlapping: OverlappingAgent[];
  totalAgentsOnFile: number;
}

export interface SessionSummary {
  sessionId: string;
  engineerId: string;
  agentId: string;
  branch: string;
  sharedFiles: string[];
  totalFiles: number;
}

/**
 * The full collision picture for a session, across ALL its files.
 */
export interface SessionAwareness {
  sessionFiles: number;
  collisions: FileCollision[];
  uniqueOverlappingSessions: number;
  overlappingSessions: SessionSummary[];
}

// ── Responses ─────────────────────────────────────────────────

export interface RegisterResponse {
  registrations: Registration[];
  awareness: SessionAwareness;
}

// ── Action Feed ───────────────────────────────────────────────

export interface Action {
  id: string;
  seq: number;
  engineerId: string;
  sessionId: string;
  agentId: string;
  file: string;
  type: "edit" | "create" | "delete" | "rename" | "test" | "command" | "decision" | "note";
  summary: string;
  symbols: string[];
  detail?: string;
  timestamp: string;
}

export interface ActionInput {
  engineerId?: string;
  sessionId: string;
  agentId: string;
  file: string;
  type: Action["type"];
  summary: string;
  symbols?: string[];
  detail?: string;
  /** Full diff for semantic analysis */
  diff?: { old: string; new: string };
}

// ── Semantic Analysis ────────────────────────────────────────

export interface SemanticAnalysis {
  id: string;
  /** The two sessions being compared */
  sessions: [string, string];
  severity: "compatible" | "potential-conflict" | "conflict";
  explanation: string;
  /** Which files are involved */
  files: string[];
  timestamp: string;
}

export interface FeedQuery {
  file?: string;
  sessionId?: string;
  excludeSession?: string;
  afterSeq?: number;
  limit?: number;
}

export interface FeedResponse {
  actions: Action[];
  cursor: number;
  total: number;
}

// ── Status ────────────────────────────────────────────────────

export interface CollisionEdge {
  file: string;
  sessions: Array<{ sessionId: string; engineerId: string; agentId: string; branch: string }>;
}

export interface RegistryStatus {
  totalRegistrations: number;
  totalFiles: number;
  totalSessions: number;
  collisionFiles: string[];
  collisionGraph: CollisionEdge[];
  registrations: Registration[];
}
