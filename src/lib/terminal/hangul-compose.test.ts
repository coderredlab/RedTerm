// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { composeJamoSequence, HangulComposer } from "./hangul-compose";

/** Drive a composer with an ordered list of IME deliveries, returning the net text. */
function netText(deliveries: string[]): string {
  const composer = new HangulComposer();
  let out = "";
  for (const data of deliveries) {
    const r = composer.feed(data);
    out = out.slice(0, out.length - r.erase) + r.send;
  }
  return out;
}

describe("HangulComposer", () => {
  test("per-syllable composed commits append", () => {
    expect(netText(["안", "녕", "하", "세", "요"])).toBe("안녕하세요");
  });

  test("jamo delta mode reassembles syllables with corrections", () => {
    // Each keystroke is committed individually: ㅎ ㅏ ㄴ ㄱ ㅡ ㄹ
    expect(netText(["ㅎ", "ㅏ", "ㄴ", "ㄱ", "ㅡ", "ㄹ"])).toBe("한글");
  });

  test("full-buffer resend mode replaces the in-progress syllable", () => {
    // The IME resends the marked text as it grows: ㅎ → 하 → 한
    expect(netText(["ㅎ", "하", "한"])).toBe("한");
  });

  test("full-buffer resend stops at the completed syllable", () => {
    // ㄱ grows to 가, then the ㄴ attaches as jong
    expect(netText(["ㄱ", "가", "간"])).toBe("간");
  });

  test("word break on trailing space starts a fresh word", () => {
    expect(netText(["안녕", " ", "하세요"])).toBe("안녕 하세요");
  });

  test("vowel merge: 가 + ㅣ → 개", () => {
    expect(netText(["ㄱ", "ㅏ", "ㅣ"])).toBe("개");
  });

  test("tense consonant: ㄱ ㄱ ㅏ → 까", () => {
    expect(netText(["ㄱ", "ㄱ", "ㅏ"])).toBe("까");
  });

  test("jong cluster: ㅁ ㅏ ㄱ ㅅ → 맋 (ㅁㅏㄳ)", () => {
    expect(netText(["ㅁ", "ㅏ", "ㄱ", "ㅅ"])).toBe("맋");
  });

  test("double jong: ㄹ ㄱ cluster detach on vowel", () => {
    // ㅁㅏㄹㄱ then ㅏ: the cluster splits — ㄹ stays jong, ㄱ starts a new syllable
    expect(netText(["ㅁ", "ㅏ", "ㄹ", "ㄱ", "ㅏ"])).toBe("말가");
  });

  test("backspace shrink via composition data", () => {
    // 한 then the IME deletes the jong: 하
    expect(netText(["ㅎ", "ㅏ", "ㄴ", "하"])).toBe("하");
  });

  test("tense resend: ㄱ → ㄲ → 까", () => {
    expect(netText(["ㄱ", "ㄲ", "까"])).toBe("까");
  });

  test("equal-length jong resend: 말 → 막", () => {
    expect(netText(["ㅁ", "마", "말", "막"])).toBe("막");
  });

  test("equal-length vowel resend: 마 → 머", () => {
    expect(netText(["ㅁ", "마", "머"])).toBe("머");
  });

  test("latin between words breaks and sends directly", () => {
    expect(netText(["ㅎㅏㄴ", "cd", "ㄱㅡㄹ"])).toBe("한cd글");
  });

  test("non-hangul only passes through untouched", () => {
    expect(netText(["ls -la", "123"])).toBe("ls -la123");
  });

  test("flushReset erases committed output on cancel", () => {
    const composer = new HangulComposer();
    composer.feed("ㅎ");
    composer.feed("ㅏ");
    const r = composer.flushReset();
    expect(r.erase).toBe(1);
    expect(r.send).toBe("");
  });

  test("breakWord keeps committed text without erasing", () => {
    const composer = new HangulComposer();
    const r1 = composer.feed("한");
    expect(r1).toEqual({ erase: 0, send: "한" });
    composer.breakWord();
    const r2 = composer.feed("ㄱㅡㄹ");
    expect(r2.send.startsWith("글") || r2.send === "ㄱ").toBe(true);
  });

  test("erase count reflects characters, not code units", () => {
    const composer = new HangulComposer();
    composer.feed("한");
    const r = composer.feed("하"); // resend shrink: replace 한 with 하
    expect(r.erase).toBe(1);
    expect(r.send).toBe("하");
  });
});

describe("composeJamoSequence", () => {
  test("composes a pure jamo run", () => {
    expect(composeJamoSequence("ㅎㅏㄴㄱㅡㄹ")).toBe("한글");
  });

  test("keeps standalone jamo that cannot form syllables", () => {
    expect(composeJamoSequence("ㄱㄴㄷ")).toBe("ㄱㄴㄷ");
  });

  test("leaves latin and digits untouched", () => {
    expect(composeJamoSequence("echo hi 123")).toBe("echo hi 123");
  });

  test("passes composed syllables through", () => {
    expect(composeJamoSequence("한글 테스트")).toBe("한글 테스트");
  });

  test("mixed latin and jamo", () => {
    expect(composeJamoSequence("cdㅎㅏㄴ")).toBe("cd한");
  });
});
