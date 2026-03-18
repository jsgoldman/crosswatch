/**
 * CrossWatch Action Feed
 *
 * Once agents are in the same space, their actions stream here.
 * Key design for N-agent scale:
 *
 * - Actions are indexed by file AND by session
 * - Pull by file (what's happening on auth.ts?)
 * - Pull by session (what are ALL other agents doing that touches my work?)
 * - Session-level pull aggregates across all collision files automatically
 * - SSE streams filter per-subscriber
 */

import { Action, ActionInput, FeedQuery, FeedResponse } from "./types";
import { Registry } from "./registry";

export class ActionFeed {
  private actions: Action[] = [];
  private fileIndex: Map<string, number[]> = new Map();
  private sessionIndex: Map<string, number[]> = new Map();
  private seq = 0;
  private listeners: Map<string, Set<(action: Action) => void>> = new Map();
  /** Max actions to keep in memory. Oldest are evicted when exceeded. */
  private maxActions: number;

  constructor(private registry: Registry, maxActions = 10000) {
    this.maxActions = maxActions;
  }

  /**
   * Record an action from an agent.
   */
  record(input: ActionInput): Action {
    this.seq++;
    const action: Action = {
      id: `act-${this.seq}`,
      seq: this.seq,
      engineerId: input.engineerId || "unknown",
      sessionId: input.sessionId,
      agentId: input.agentId,
      file: this.norm(input.file),
      type: input.type,
      summary: input.summary,
      symbols: input.symbols || [],
      detail: input.detail,
      timestamp: new Date().toISOString(),
    };

    // Touch the session's activity clock
    this.registry.touch(input.sessionId);

    const idx = this.actions.length;
    this.actions.push(action);

    // Index by file
    if (!this.fileIndex.has(action.file)) this.fileIndex.set(action.file, []);
    this.fileIndex.get(action.file)!.push(idx);

    // Index by session
    if (!this.sessionIndex.has(action.sessionId)) this.sessionIndex.set(action.sessionId, []);
    this.sessionIndex.get(action.sessionId)!.push(idx);

    // Notify SSE listeners
    this.notifyListeners(action);

    // Evict oldest actions if over limit
    if (this.actions.length > this.maxActions) {
      this.evict(Math.floor(this.maxActions * 0.2));
    }

    return action;
  }

  /**
   * Remove the oldest N non-undefined actions and rebuild indices.
   */
  private evict(count: number): void {
    // Compact: remove undefined holes and oldest entries
    const live = this.actions.filter((a): a is Action => a !== undefined);
    const kept = live.slice(count);

    this.actions = kept;
    this.fileIndex.clear();
    this.sessionIndex.clear();

    for (let i = 0; i < kept.length; i++) {
      const a = kept[i];
      if (!this.fileIndex.has(a.file)) this.fileIndex.set(a.file, []);
      this.fileIndex.get(a.file)!.push(i);
      if (!this.sessionIndex.has(a.sessionId)) this.sessionIndex.set(a.sessionId, []);
      this.sessionIndex.get(a.sessionId)!.push(i);
    }
  }

  /**
   * Query actions. Supports:
   * - By file: all actions on a specific file from other agents
   * - By session: all actions FROM a specific session (to see what they did)
   * - Session-aware: pass excludeSession to filter out your own actions
   * - Cursor-based: pass afterSeq for incremental polling
   */
  query(q: FeedQuery): FeedResponse {
    let candidates: number[];

    if (q.file) {
      candidates = this.fileIndex.get(this.norm(q.file)) || [];
    } else if (q.sessionId) {
      candidates = this.sessionIndex.get(q.sessionId) || [];
    } else {
      // All actions
      candidates = this.actions.map((_, i) => i);
    }

    const limit = q.limit || 50;
    const afterSeq = q.afterSeq || 0;
    const filtered: Action[] = [];

    for (const idx of candidates) {
      const a = this.actions[idx];
      if (!a) continue;
      if (q.excludeSession && a.sessionId === q.excludeSession) continue;
      if (a.seq > afterSeq) filtered.push(a);
    }

    const result = filtered.slice(-limit);
    const cursor = result.length > 0 ? result[result.length - 1].seq : afterSeq;

    return { actions: result, cursor, total: filtered.length };
  }

  /**
   * Pull everything relevant to a session: actions from OTHER agents
   * on all files that this session has collisions on.
   * This is the session-level aggregate view.
   */
  pullForSession(sessionId: string, afterSeq?: number): FeedResponse {
    // Get the session's collision files from the registry
    const awareness = this.registry.getSessionAwareness(sessionId);
    const collisionFiles = awareness.collisions.map((c) => c.file);

    if (collisionFiles.length === 0) {
      return { actions: [], cursor: afterSeq || 0, total: 0 };
    }

    // Gather actions across all collision files from other agents
    const seq = afterSeq || 0;
    const seen = new Set<string>();
    const all: Action[] = [];

    for (const file of collisionFiles) {
      const indices = this.fileIndex.get(file) || [];
      for (const idx of indices) {
        const a = this.actions[idx];
        if (!a) continue;
        if (a.sessionId === sessionId) continue;
        if (a.seq <= seq) continue;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        all.push(a);
      }
    }

    // Sort by sequence
    all.sort((a, b) => a.seq - b.seq);

    const cursor = all.length > 0 ? all[all.length - 1].seq : seq;
    return { actions: all, cursor, total: all.length };
  }

  /**
   * Format a session-level feed into text for LLM context injection.
   * Groups by file, then by agent within each file.
   */
  summarizeForSession(sessionId: string, afterSeq?: number): string {
    const feed = this.pullForSession(sessionId, afterSeq);

    if (feed.actions.length === 0) {
      return "No new activity from other agents on your collision files.";
    }

    // Group by file, then by agent
    const byFile = new Map<string, Map<string, Action[]>>();
    for (const action of feed.actions) {
      if (!byFile.has(action.file)) byFile.set(action.file, new Map());
      const agents = byFile.get(action.file)!;
      const engineer = action.engineerId !== "unknown" ? action.engineerId : "";
      const key = engineer
        ? `${action.agentId} [${engineer}] (${action.sessionId})`
        : `${action.agentId} (${action.sessionId})`;
      if (!agents.has(key)) agents.set(key, []);
      agents.get(key)!.push(action);
    }

    const lines: string[] = [
      `CROSSWATCH LIVE FEED: ${feed.actions.length} action(s) across ${byFile.size} file(s)`,
      "",
    ];

    for (const [file, agents] of byFile) {
      lines.push(`--- ${file} ---`);
      for (const [agent, actions] of agents) {
        lines.push(`  ${agent}:`);
        for (const a of actions) {
          const time = a.timestamp.split("T")[1]?.slice(0, 8) || "";
          const sym = a.symbols.length > 0 ? ` [${a.symbols.join(", ")}]` : "";
          lines.push(`    ${time} ${a.type}${sym}: ${a.summary}`);
          if (a.detail) {
            for (const dl of a.detail.split("\n").slice(0, 3)) {
              lines.push(`      ${dl}`);
            }
          }
        }
      }
      lines.push("");
    }

    lines.push(
      "Review the above. These are real-time actions from other agents on files " +
      "you are also working on. Decide whether any of this affects your approach."
    );

    return lines.join("\n");
  }

  /**
   * Format a single-file feed.
   */
  summarizeForFile(file: string, excludeSession?: string, afterSeq?: number): string {
    const feed = this.query({ file, excludeSession, afterSeq, limit: 30 });

    if (feed.actions.length === 0) {
      return "No new activity from other agents on this file.";
    }

    const byAgent = new Map<string, Action[]>();
    for (const a of feed.actions) {
      const engineer = a.engineerId !== "unknown" ? a.engineerId : "";
      const key = engineer
        ? `${a.agentId} [${engineer}] (${a.sessionId})`
        : `${a.agentId} (${a.sessionId})`;
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key)!.push(a);
    }

    const lines: string[] = [
      `LIVE FEED: ${feed.total} action(s) from other agents on ${file}`,
      "",
    ];

    for (const [agent, actions] of byAgent) {
      lines.push(`${agent}:`);
      for (const a of actions) {
        const time = a.timestamp.split("T")[1]?.slice(0, 8) || "";
        const sym = a.symbols.length > 0 ? ` [${a.symbols.join(", ")}]` : "";
        lines.push(`  ${time} ${a.type}${sym}: ${a.summary}`);
        if (a.detail) {
          for (const dl of a.detail.split("\n").slice(0, 3)) {
            lines.push(`    ${dl}`);
          }
        }
      }
      lines.push("");
    }

    lines.push("Review the above and decide whether this affects your current approach.");
    return lines.join("\n");
  }

  /**
   * Subscribe to real-time actions. Listener receives actions from
   * OTHER sessions on the specified file.
   */
  subscribe(
    file: string,
    excludeSession: string,
    callback: (action: Action) => void
  ): () => void {
    const key = `${this.norm(file)}::${excludeSession}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(callback);

    return () => {
      this.listeners.get(key)?.delete(callback);
      if (this.listeners.get(key)?.size === 0) this.listeners.delete(key);
    };
  }

  /**
   * Subscribe to actions across ALL collision files for a session.
   * Fires whenever any other agent does anything on any file that
   * overlaps with this session.
   */
  subscribeSession(
    sessionId: string,
    callback: (action: Action) => void
  ): () => void {
    const key = `session::${sessionId}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(callback);

    return () => {
      this.listeners.get(key)?.delete(callback);
      if (this.listeners.get(key)?.size === 0) this.listeners.delete(key);
    };
  }

  purgeSession(sessionId: string): number {
    const indices = this.sessionIndex.get(sessionId) || [];
    let count = 0;
    for (const idx of indices) {
      if (this.actions[idx]) {
        const file = this.actions[idx].file;
        const fi = this.fileIndex.get(file);
        if (fi) {
          const pos = fi.indexOf(idx);
          if (pos !== -1) fi.splice(pos, 1);
          if (fi.length === 0) this.fileIndex.delete(file);
        }
        (this.actions as any)[idx] = undefined;
        count++;
      }
    }
    this.sessionIndex.delete(sessionId);
    return count;
  }

  private notifyListeners(action: Action) {
    // Per-file listeners
    for (const [key, callbacks] of this.listeners) {
      if (key.startsWith("session::")) {
        // Session-level subscriber: check if this action's file
        // is a collision file for the subscribing session
        const subscriberSession = key.slice(9);
        if (action.sessionId === subscriberSession) continue;

        const awareness = this.registry.getSessionAwareness(subscriberSession);
        const collisionFiles = awareness.collisions.map((c) => c.file);
        if (collisionFiles.includes(action.file)) {
          for (const cb of callbacks) cb(action);
        }
      } else {
        // Per-file listener
        const [file, excludeSession] = key.split("::");
        if (action.file === file && action.sessionId !== excludeSession) {
          for (const cb of callbacks) cb(action);
        }
      }
    }
  }

  private norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/$/, "");
  }
}
