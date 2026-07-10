/**
 * LLM moderator interface + Noop implementation (MVP stub).
 *
 * Per spec §8: the real provider call is intentionally not wired in MVP.
 * `LLM_ENABLED=false` keeps this dormant. The integration point in the
 * moderation pipeline is the "gray zone" between ban-word check (§7.5)
 * and escalation (§7.6): borderline messages are sent to `classify()`
 * and the result is folded into the final score.
 *
 * To activate later: implement a concrete class (e.g. OpenAiLlmModerator)
 * that calls the provider and returns a real verdict, then instantiate it
 * in place of NoopLlmModerator when `config.LLM_ENABLED` is true.
 */

export interface LlmModerationResult {
  spam: boolean;
  /** confidence in the verdict, 0..1 */
  confidence: number;
  /** short human-readable reason, optional */
  reason?: string;
}

export interface LlmModerator {
  classify(text: string): Promise<LlmModerationResult>;
}

/** Always returns "not spam". Drop-in placeholder until a provider is wired. */
export class NoopLlmModerator implements LlmModerator {
  async classify(): Promise<LlmModerationResult> {
    return { spam: false, confidence: 0 };
  }
}

let instance: LlmModerator | null = null;

/**
 * Returns the singleton moderator instance.
 * Currently always a Noop; swap here when a real provider is added.
 */
export function getLlmModerator(): LlmModerator {
  if (!instance) {
    // Future: if (config.LLM_ENABLED) instance = new RealLlmModerator(...)
    instance = new NoopLlmModerator();
  }
  return instance;
}
