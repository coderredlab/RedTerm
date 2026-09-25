// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { Osc52SessionGate } from "./terminal-osc52";

describe("Osc52SessionGate", () => {

  test("asks once per connection generation and remembers approval", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return true;
    };

    expect(await gate.resolve("first", 1, confirm)).toBe("first");
    expect(await gate.resolve("second", 1, confirm)).toBe("second");
    expect(confirmCalls).toBe(1);
  });

  test("asks again on every attempt after a denial for the same generation", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return false;
    };

    expect(await gate.resolve("first", 1, confirm)).toBeNull();
    expect(await gate.resolve("second", 1, confirm)).toBeNull();
    expect(await gate.resolve("third", 1, confirm)).toBeNull();
    expect(confirmCalls).toBe(3);
  });

  test("asks again when the connection generation moves", async () => {
    const gate = new Osc52SessionGate();
    let confirmCalls = 0;
    const confirm = async () => {
      confirmCalls++;
      return true;
    };

    expect(await gate.resolve("old session", 1, confirm)).toBe("old session");
    expect(await gate.resolve("new session", 2, confirm)).toBe("new session");
    expect(confirmCalls).toBe(2);
  });

  test("drops payloads arriving while a confirmation is open", async () => {
    const gate = new Osc52SessionGate();
    let releaseConfirm: ((value: boolean) => void) | null = null;
    const confirm = () => new Promise<boolean>((resolve) => (releaseConfirm = resolve));

    const held = gate.resolve("held", 1, confirm);
    expect(await gate.resolve("dropped while pending", 1, confirm)).toBeNull();
    releaseConfirm?.(true);
    expect(await held).toBe("held");
  });

});
