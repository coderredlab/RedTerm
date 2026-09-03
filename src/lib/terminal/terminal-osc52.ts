/**
 * Session-scoped approval gate for remote OSC 52 clipboard writes.
 *
 * Approvals and denials are keyed to the connection generation: every
 * re-connection bumps the generation, which automatically invalidates the
 * previous decision — no explicit reset call sites to miss. Payloads arriving
 * while a confirmation is already open are dropped, and a decision confirmed
 * after the generation moved on is discarded by the caller re-checking
 * `generation !== connectionGeneration` before the sink.
 */
export class Osc52SessionGate {
  private decidedGeneration: number | null = null;
  private allowed = false;
  private pending = false;

  async resolve(
    text: string,
    trusted: boolean,
    generation: number,
    confirm: () => Promise<boolean>
  ): Promise<string | null> {
    if (trusted) return text;
    if (this.pending) return null;
    if (this.decidedGeneration === generation) {
      return this.allowed ? text : null;
    }
    this.pending = true;
    try {
      const decision = await confirm();
      this.decidedGeneration = generation;
      this.allowed = decision;
      return decision ? text : null;
    } finally {
      this.pending = false;
    }
  }
}
