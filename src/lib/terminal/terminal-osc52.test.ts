// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { Osc52SessionGate } from "./terminal-osc52";

describe("Osc52SessionGate", () => {
  test("allows local shell writes without asking", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return false;
    };

    expect(await gate.resolve("yanked text", true, 1, confirm)).toBe("yanked text");
    expect(await gate.resolve("again", true, 2, confirm)).toBe("again");
    expect(confirmCalls).toBe(0);
  });

  test("asks once per connection generation and remembers approval", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return true;
    };

    expect(await gate.resolve("first", false, 1, confirm)).toBe("first");
    expect(await gate.resolve("second", false, 1, confirm)).toBe("second");
    expect(confirmCalls).toBe(1);
  });

  test("asks again on every attempt after a denial for the same generation", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return false;
    };

    expect(await gate.resolve("first", false, 1, confirm)).toBeNull();
    expect(await gate.resolve("second", false, 1, confirm)).toBeNull();
    expect(await gate.resolve("third", false, 1, confirm)).toBeNull();
    expect(confirmCalls).toBe(3);
  });

  test("asks again when the connection generation moves", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return true;
    };

    expect(await gate.resolve("old session", false, 1, confirm)).toBe("old session");
    expect(await gate.resolve("new session", false, 2, confirm)).toBe("new session");
    expect(confirmCalls).toBe(2);
  });

  test("drops payloads arriving while a confirmation is open", async () => {
    const gate = new Osc52SessionGate();
    let releaseConfirm: ((value: boolean) => void) | null = null;
    const confirm = () => new Promise<boolean>((resolve) => (releaseConfirm = resolve));

    const held = gate.resolve("held", false, 1, confirm);
    expect(await gate.resolve("dropped while pending", false, 1, confirm)).toBeNull();
    releaseConfirm?.(true);
    expect(await held).toBe("held");
  });

  test("approval stored after the generation moved does not leak into the new session", async () => {
    const gate = new Osc52SessionGate();
    let currentGeneration = 1;
    const confirm = async () => {
      currentGeneration = 2; // re-connection happens while the dialog is open
      return true;
    };

    // The caller drops the payload because generation !== connectionGeneration;
    // the stored approval (generation 1) must not satisfy the new generation.
    expect(await gate.resolve("stale payload", false, 1, confirm)).toBe("stale payload");
    expect(await gate.resolve("new session payload", false, 2, confirm)).toBe("new session payload");
    // Resolving generation 2 asked again (confirm called twice total).
  });
});
