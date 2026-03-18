/**
 * CrossWatch Semantic Analyzer
 *
 * When two agents are editing the same codebase, sends their recent
 * diffs to an LLM to determine whether the changes are compatible,
 * potentially conflicting, or directly conflicting.
 *
 * Provider-agnostic: supports Anthropic or OpenAI. Set the
 * corresponding API key env var to enable.
 *
 *   ANTHROPIC_API_KEY → Anthropic (default)
 *   OPENAI_API_KEY    → OpenAI
 *
 * Override the model with CROSSWATCH_MODEL.
 */

import { Action, SemanticAnalysis } from "./types";

// ── LLM Provider Abstraction ────────────────────────────────────

interface LLMProvider {
  name: string;
  analyze(system: string, prompt: string): Promise<string>;
}

const SYSTEM_PROMPT =
  "You analyze whether code changes from two AI agents working on the same codebase are compatible. " +
  "Focus on semantic conflicts: type signature changes, behavioral contract changes, renamed/deleted symbols " +
  "that the other agent depends on, import/export relationships, and logical incompatibilities. " +
  "Two agents editing the same file is NOT a conflict if their changes don't interact. " +
  "Be specific about what would break and why.\n\n" +
  "Respond with ONLY a JSON object (no markdown, no code fences) with these fields:\n" +
  '- "severity": one of "compatible", "potential-conflict", or "conflict"\n' +
  '- "explanation": 2-3 sentence explanation. If conflict, state specifically what will break.';

const VALID_SEVERITIES = new Set(["compatible", "potential-conflict", "conflict"]);

function createAnthropicProvider(apiKey: string, model: string): LLMProvider {
  // Lazy-load to avoid requiring the package if not used
  const Anthropic = require("@anthropic-ai/sdk").default;
  const client = new Anthropic({ apiKey });

  return {
    name: `Anthropic (${model})`,
    async analyze(system: string, prompt: string): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find((b: any) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text block in Anthropic response");
      }
      return textBlock.text;
    },
  };
}

function createOpenAIProvider(apiKey: string, model: string): LLMProvider {
  const OpenAI = require("openai").default;
  const client = new OpenAI({ apiKey });

  return {
    name: `OpenAI (${model})`,
    async analyze(system: string, prompt: string): Promise<string> {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 300,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      const text = response.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error("No content in OpenAI response");
      }
      return text;
    },
  };
}

function createGoogleProvider(apiKey: string, model: string): LLMProvider {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    name: `Google (${model})`,
    async analyze(system: string, prompt: string): Promise<string> {
      const genModel = genAI.getGenerativeModel({
        model,
        systemInstruction: system,
      });
      const result = await genModel.generateContent(prompt);
      const text = result.response.text();
      if (!text) {
        throw new Error("No content in Google response");
      }
      return text;
    },
  };
}

function detectProvider(): LLMProvider | null {
  const overrideModel = process.env.CROSSWATCH_MODEL;

  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider(
      process.env.ANTHROPIC_API_KEY,
      overrideModel || "claude-sonnet-4-6"
    );
  }
  if (process.env.OPENAI_API_KEY) {
    return createOpenAIProvider(
      process.env.OPENAI_API_KEY,
      overrideModel || "gpt-4o"
    );
  }
  if (process.env.GOOGLE_API_KEY) {
    return createGoogleProvider(
      process.env.GOOGLE_API_KEY,
      overrideModel || "gemini-2.0-flash"
    );
  }
  return null;
}

// ── Semantic Analyzer ───────────────────────────────────────────

export class SemanticAnalyzer {
  private provider: LLMProvider | null;
  /** Cache: "sessionA::sessionB" → analysis */
  private cache: Map<string, SemanticAnalysis> = new Map();
  /** Track which action seqs have been analyzed to avoid re-analysis */
  private analyzedUpTo: Map<string, number> = new Map();
  private seq = 0;

  constructor() {
    this.provider = detectProvider();
  }

  isAvailable(): boolean {
    return this.provider !== null;
  }

  providerName(): string {
    return this.provider?.name || "none";
  }

  /**
   * Analyze whether two agents' recent changes are semantically compatible.
   * Returns cached result if nothing has changed since last analysis.
   */
  async analyze(
    sessionA: { sessionId: string; agentId: string; branch: string; intent?: string; actions: Action[] },
    sessionB: { sessionId: string; agentId: string; branch: string; intent?: string; actions: Action[] }
  ): Promise<SemanticAnalysis | null> {
    if (!this.provider) return null;

    // Sort session IDs for consistent cache keys
    const [first, second] = [sessionA, sessionB].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId)
    );
    const cacheKey = `${first.sessionId}::${second.sessionId}`;

    // Check if we've already analyzed these exact actions
    const maxSeq = Math.max(
      ...first.actions.map((a) => a.seq),
      ...second.actions.map((a) => a.seq),
      0
    );
    const prevSeq = this.analyzedUpTo.get(cacheKey) || 0;
    if (maxSeq <= prevSeq && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Build the prompt
    const prompt = this.buildPrompt(sessionA, sessionB);

    try {
      const raw = await this.provider.analyze(SYSTEM_PROMPT, prompt);
      const parsed = JSON.parse(raw);

      // Validate severity
      if (!parsed.severity || !VALID_SEVERITIES.has(parsed.severity)) {
        console.error(
          `[SemanticAnalyzer] Invalid severity "${parsed.severity}", defaulting to "potential-conflict"`
        );
        parsed.severity = "potential-conflict";
      }
      if (typeof parsed.explanation !== "string") {
        parsed.explanation = "Analysis returned no explanation.";
      }

      this.seq++;
      const analysis: SemanticAnalysis = {
        id: `sem-${this.seq}`,
        sessions: [first.sessionId, second.sessionId],
        severity: parsed.severity,
        explanation: parsed.explanation,
        files: [
          ...new Set([
            ...first.actions.map((a) => a.file),
            ...second.actions.map((a) => a.file),
          ]),
        ],
        timestamp: new Date().toISOString(),
      };

      this.cache.set(cacheKey, analysis);
      this.analyzedUpTo.set(cacheKey, maxSeq);

      return analysis;
    } catch (e) {
      console.error("[SemanticAnalyzer] LLM call failed:", (e as Error).message);
      return null;
    }
  }

  /**
   * Get cached analysis for a session pair without triggering a new analysis.
   */
  getCached(sessionA: string, sessionB: string): SemanticAnalysis | null {
    const [first, second] = [sessionA, sessionB].sort();
    return this.cache.get(`${first}::${second}`) || null;
  }

  /**
   * Get all cached analyses involving a session.
   */
  getForSession(sessionId: string): SemanticAnalysis[] {
    const results: SemanticAnalysis[] = [];
    for (const analysis of this.cache.values()) {
      if (analysis.sessions.includes(sessionId)) {
        results.push(analysis);
      }
    }
    return results;
  }

  purgeSession(sessionId: string): void {
    for (const [key, analysis] of this.cache) {
      if (analysis.sessions.includes(sessionId)) {
        this.cache.delete(key);
        this.analyzedUpTo.delete(key);
      }
    }
  }

  private buildPrompt(
    a: { agentId: string; branch: string; intent?: string; actions: Action[] },
    b: { agentId: string; branch: string; intent?: string; actions: Action[] }
  ): string {
    const formatAgent = (agent: typeof a, label: string) => {
      const lines: string[] = [];
      lines.push(`## ${label}: ${agent.agentId} (${agent.branch})`);
      if (agent.intent) {
        lines.push(`Task: ${agent.intent}`);
      }
      lines.push("");

      // Only include the most recent actions (last 5) to keep prompt small
      const recent = agent.actions.slice(-5);
      for (const action of recent) {
        lines.push(`### ${action.file}`);
        lines.push(`Action: ${action.summary}`);
        if (action.symbols.length > 0) {
          lines.push(`Symbols: ${action.symbols.join(", ")}`);
        }
        if (action.detail) {
          lines.push("```");
          lines.push(action.detail.slice(0, 1000));
          lines.push("```");
        }
        lines.push("");
      }

      return lines.join("\n");
    };

    return [
      "Two AI agents are editing the same codebase. Analyze whether their changes are semantically compatible.\n",
      formatAgent(a, "Agent A"),
      formatAgent(b, "Agent B"),
      "Analyze: are these changes compatible, potentially conflicting, or directly conflicting?",
    ].join("\n");
  }
}
