/**
 * CrossWatch Registry
 *
 * Bulletin board for N agents across M files.
 * Awareness is computed at the SESSION level, not per-file.
 * When you register, you get back the full collision graph —
 * every file you've registered on that has other agents,
 * and every other session that overlaps with your work.
 *
 * Supports batch registration (multiple files in one call)
 * because agents often know up front which files they'll touch.
 *
 * engineerId identifies which human engineer owns a session,
 * so collisions can be grouped as "your own agents" vs
 * "another engineer's agents".
 */

import { v4 as uuid } from "uuid";
import {
  Registration,
  RegisterInput,
  FileIntent,
  RegisterResponse,
  SessionAwareness,
  FileCollision,
  SessionSummary,
  OverlappingAgent,
  RegistryStatus,
  CollisionEdge,
} from "./types";

export class Registry {
  private registrations: Map<string, Registration> = new Map();
  private fileIndex: Map<string, Set<string>> = new Map();
  private sessionIndex: Map<string, Set<string>> = new Map();
  private sessionIntents: Map<string, string> = new Map();
  /** Last activity timestamp per session (epoch ms) for auto-expiry */
  private lastActivity: Map<string, number> = new Map();

  setSessionIntent(sessionId: string, intent: string): void {
    // Only store the first one — that's the original task
    if (!this.sessionIntents.has(sessionId)) {
      this.sessionIntents.set(sessionId, intent);
    }
  }

  getSessionIntent(sessionId: string): string | undefined {
    return this.sessionIntents.get(sessionId);
  }

  getSessionBranch(sessionId: string): string | undefined {
    const regIds = this.sessionIndex.get(sessionId);
    if (!regIds) return undefined;
    for (const id of regIds) {
      const reg = this.registrations.get(id);
      if (reg) return reg.branch;
    }
    return undefined;
  }

  /** Mark a session as active (resets expiry clock). */
  touch(sessionId: string): void {
    this.lastActivity.set(sessionId, Date.now());
  }

  /** Return session IDs that have been idle longer than ttlMs. */
  getExpiredSessions(ttlMs: number): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [sessionId, lastTime] of this.lastActivity) {
      if (now - lastTime > ttlMs) {
        expired.push(sessionId);
      }
    }
    return expired;
  }

  /**
   * Register one or more files. Returns the full session-level
   * awareness across ALL files this session has ever registered.
   */
  register(input: RegisterInput): RegisterResponse {
    // Normalize to a list of file intents
    const intents: FileIntent[] = [];

    if (input.files && input.files.length > 0) {
      intents.push(...input.files);
    } else if (input.file && input.intent) {
      intents.push({
        file: input.file,
        symbols: input.symbols,
        intent: input.intent,
        impact: input.impact,
      });
    }

    if (intents.length === 0) {
      return {
        registrations: [],
        awareness: this.getSessionAwareness(input.sessionId),
      };
    }

    const newRegs: Registration[] = [];

    for (const fi of intents) {
      const reg: Registration = {
        id: uuid(),
        engineerId: input.engineerId || "unknown",
        agentId: input.agentId,
        sessionId: input.sessionId,
        file: this.norm(fi.file),
        symbols: fi.symbols || [],
        intent: fi.intent,
        impact: fi.impact || "",
        branch: input.branch || "unknown",
        timestamp: new Date().toISOString(),
      };

      this.registrations.set(reg.id, reg);

      if (!this.fileIndex.has(reg.file)) {
        this.fileIndex.set(reg.file, new Set());
      }
      this.fileIndex.get(reg.file)!.add(reg.id);

      if (!this.sessionIndex.has(reg.sessionId)) {
        this.sessionIndex.set(reg.sessionId, new Set());
      }
      this.sessionIndex.get(reg.sessionId)!.add(reg.id);

      newRegs.push(reg);
    }

    this.touch(input.sessionId);

    // Session-level awareness: ALL collisions across ALL files for this session
    const awareness = this.getSessionAwareness(input.sessionId);

    return { registrations: newRegs, awareness };
  }

  /**
   * Get full session-level awareness. Every file this session has
   * registered on that has other agents, plus a de-duped summary
   * of all overlapping sessions.
   */
  getSessionAwareness(sessionId: string): SessionAwareness {
    const myRegIds = this.sessionIndex.get(sessionId);
    if (!myRegIds || myRegIds.size === 0) {
      return {
        sessionFiles: 0,
        collisions: [],
        uniqueOverlappingSessions: 0,
        overlappingSessions: [],
      };
    }

    // Find all files this session is on
    const myFiles = new Set<string>();
    for (const id of myRegIds) {
      const reg = this.registrations.get(id);
      if (reg) myFiles.add(reg.file);
    }

    // For each file, find overlapping agents from other sessions
    const collisions: FileCollision[] = [];
    const sessionMap = new Map<string, {
      engineerId: string;
      agentId: string;
      branch: string;
      sharedFiles: Set<string>;
      totalFiles: number;
    }>();

    for (const file of myFiles) {
      const regIds = this.fileIndex.get(file);
      if (!regIds) continue;

      const overlapping: OverlappingAgent[] = [];
      const sessionsSeen = new Set<string>();

      for (const id of regIds) {
        const reg = this.registrations.get(id);
        if (!reg || reg.sessionId === sessionId) continue;

        // Track this session for the de-duped summary
        if (!sessionMap.has(reg.sessionId)) {
          // Count total files for this session
          const theirRegIds = this.sessionIndex.get(reg.sessionId);
          const theirFiles = new Set<string>();
          if (theirRegIds) {
            for (const rid of theirRegIds) {
              const r = this.registrations.get(rid);
              if (r) theirFiles.add(r.file);
            }
          }
          sessionMap.set(reg.sessionId, {
            engineerId: reg.engineerId,
            agentId: reg.agentId,
            branch: reg.branch,
            sharedFiles: new Set(),
            totalFiles: theirFiles.size,
          });
        }
        sessionMap.get(reg.sessionId)!.sharedFiles.add(file);

        // Aggregate per-session on this file
        if (!sessionsSeen.has(reg.sessionId)) {
          sessionsSeen.add(reg.sessionId);

          const sessionRegsOnFile = Array.from(regIds)
            .map((rid) => this.registrations.get(rid))
            .filter(
              (r): r is Registration =>
                r !== undefined && r.sessionId === reg.sessionId
            );

          const allSymbols = [...new Set(sessionRegsOnFile.flatMap((r) => r.symbols))];
          const intents = sessionRegsOnFile.map((r) => r.intent).join("; ");
          const impacts = sessionRegsOnFile.map((r) => r.impact).filter(Boolean).join("; ");

          overlapping.push({
            engineerId: reg.engineerId,
            agentId: reg.agentId,
            sessionId: reg.sessionId,
            branch: reg.branch,
            symbols: allSymbols,
            intent: intents,
            impact: impacts,
            registeredAt: reg.timestamp,
            sessionIntent: this.sessionIntents.get(reg.sessionId),
          });
        }
      }

      if (overlapping.length > 0) {
        collisions.push({
          file,
          overlapping,
          totalAgentsOnFile: overlapping.length + 1,
        });
      }
    }

    // Build de-duped session summaries
    const overlappingSessions: SessionSummary[] = Array.from(sessionMap.entries()).map(
      ([sid, info]) => ({
        sessionId: sid,
        engineerId: info.engineerId,
        agentId: info.agentId,
        branch: info.branch,
        sharedFiles: Array.from(info.sharedFiles),
        totalFiles: info.totalFiles,
      })
    );

    return {
      sessionFiles: myFiles.size,
      collisions,
      uniqueOverlappingSessions: overlappingSessions.length,
      overlappingSessions,
    };
  }

  /**
   * Check a single file for other agents without registering.
   */
  checkFile(file: string, excludeSession?: string): FileCollision | null {
    const normalized = this.norm(file);
    const regIds = this.fileIndex.get(normalized);
    if (!regIds) return null;

    const overlapping: OverlappingAgent[] = [];
    const sessionsSeen = new Set<string>();

    for (const id of regIds) {
      const reg = this.registrations.get(id);
      if (!reg || reg.sessionId === excludeSession) continue;
      if (sessionsSeen.has(reg.sessionId)) continue;
      sessionsSeen.add(reg.sessionId);

      overlapping.push({
        engineerId: reg.engineerId,
        agentId: reg.agentId,
        sessionId: reg.sessionId,
        branch: reg.branch,
        symbols: reg.symbols,
        intent: reg.intent,
        impact: reg.impact,
        registeredAt: reg.timestamp,
        sessionIntent: this.sessionIntents.get(reg.sessionId),
      });
    }

    if (overlapping.length === 0) return null;

    // Count the caller too, but only if they're actually registered on this file
    const callerOnFile = excludeSession
      ? [...regIds].some(id => {
          const r = this.registrations.get(id);
          return r && r.sessionId === excludeSession;
        })
      : false;

    return {
      file: normalized,
      overlapping,
      totalAgentsOnFile: overlapping.length + (callerOnFile ? 1 : 0),
    };
  }

  deregister(registrationId: string): boolean {
    const reg = this.registrations.get(registrationId);
    if (!reg) return false;

    this.registrations.delete(registrationId);
    this.fileIndex.get(reg.file)?.delete(registrationId);
    this.sessionIndex.get(reg.sessionId)?.delete(registrationId);

    if (this.fileIndex.get(reg.file)?.size === 0) this.fileIndex.delete(reg.file);
    if (this.sessionIndex.get(reg.sessionId)?.size === 0) this.sessionIndex.delete(reg.sessionId);

    return true;
  }

  deregisterSession(sessionId: string): number {
    const regIds = this.sessionIndex.get(sessionId);
    if (!regIds) return 0;

    let count = 0;
    for (const id of regIds) {
      const reg = this.registrations.get(id);
      if (reg) {
        this.registrations.delete(id);
        this.fileIndex.get(reg.file)?.delete(id);
        if (this.fileIndex.get(reg.file)?.size === 0) this.fileIndex.delete(reg.file);
        count++;
      }
    }
    this.sessionIndex.delete(sessionId);
    this.sessionIntents.delete(sessionId);
    this.lastActivity.delete(sessionId);
    return count;
  }

  status(): RegistryStatus {
    const allRegs = Array.from(this.registrations.values());
    const sessions = new Set(allRegs.map((r) => r.sessionId));

    const collisionFiles: string[] = [];
    const collisionGraph: CollisionEdge[] = [];

    for (const [file, regIds] of this.fileIndex) {
      const sessionsOnFile = new Map<string, { engineerId: string; agentId: string; branch: string }>();
      for (const id of regIds) {
        const reg = this.registrations.get(id);
        if (reg && !sessionsOnFile.has(reg.sessionId)) {
          sessionsOnFile.set(reg.sessionId, {
            engineerId: reg.engineerId,
            agentId: reg.agentId,
            branch: reg.branch,
          });
        }
      }
      if (sessionsOnFile.size > 1) {
        collisionFiles.push(file);
        collisionGraph.push({
          file,
          sessions: Array.from(sessionsOnFile.entries()).map(([sid, info]) => ({
            sessionId: sid,
            ...info,
          })),
        });
      }
    }

    return {
      totalRegistrations: this.registrations.size,
      totalFiles: this.fileIndex.size,
      totalSessions: sessions.size,
      collisionFiles,
      collisionGraph,
      registrations: allRegs,
    };
  }

  private norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/$/, "");
  }
}
