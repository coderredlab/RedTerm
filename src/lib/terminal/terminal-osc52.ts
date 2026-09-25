/**
 * Session-scoped approval gate for OSC 52 clipboard writes from all terminal
 * output, including local PTYs that can relay untrusted nested SSH bytes.
 * Approvals are keyed to the connection generation: every re-connection bumps
 * the generation, which automatically invalidates the previous approval — no
 * explicit reset call sites to miss. A denial is never cached; the next
 * attempt asks again. Payloads arriving while a confirmation is already open
 * are dropped, and a decision confirmed after the generation moved on is
 * discarded by the caller re-checking
 * `generation !== connectionGeneration` before the sink.
 */
export class Osc52SessionGate {
  private approvedGeneration: number | null = null;
  private pending = false;

  async resolve(
    text: string,
    generation: number,
    confirm: () => Promise<boolean>
  ): Promise<string | null> {
    if (this.pending) return null;
    if (this.approvedGeneration === generation) {
      return text;
    }
    this.pending = true;
    try {
      const decision = await confirm();
      if (!decision) return null;
      this.approvedGeneration = generation;
      return text;
    } finally {
      this.pending = false;
    }
  }
}
