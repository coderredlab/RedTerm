// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { AndroidRemoteTextOrigins, AndroidTextDelta, isCanceledAndroidCompositionValue } from "./android-text-delta";

describe("Android textarea edit ownership", () => {
  test("sends only the inserted characters when a marked word replaces itself across compositions", () => {
    const input = new AndroidTextDelta();
    const sent: string[] = [];
    for (const value of ["n", "nv", "nvi", "nvim"]) {
      input.compositionStart();
      const change = input.input(value, "insertCompositionText", value);
      if (change) sent.push(change.text);
      expect(input.compositionEnd(value, value)).toBeNull();
      expect(input.input(value, "insertText")).toBeNull();
    }
    expect(sent).toEqual(["n", "v", "i", "m"]);
  });

  test("preserves independent n then nv commits and a separate identical character", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("n", "insertCompositionText", "n")).toEqual({ erase: 0, text: "n" });
    expect(input.compositionEnd("n", "n")).toBeNull();
    input.compositionStart();
    expect(input.input("nnv", "insertCompositionText", "nv")).toEqual({ erase: 0, text: "nv" });
    expect(input.compositionEnd("nnv", "nv")).toBeNull();
    expect(input.input("nnvn", "insertText")).toEqual({ erase: 0, text: "n" });
  });

  test("an explicit soft selection replaces committed text even while its provisional DOM word has not changed", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.hasPendingCommit).toBe(true);
    // Without a selected beforeinput this same value is only a candidate echo.
    expect(input.input("가", "insertText", "가")).toBeNull();
    expect(input.replaceSelectedPending("가", "가", 0, 1, "가")).toEqual({ erase: 1, text: "가" });
    expect(input.editorValue).toBe("가");
    expect(input.input("각", "insertFromComposition", "각")).toBeNull();
    expect(input.editorValue).toBe("가");
    expect(input.input("가b", "insertText", "b")).toEqual({ erase: 0, text: "b" });
  });

  test("a data-less delayed composition echo cannot undo a selected soft replacement", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.replaceSelectedPending("가", "가", 0, 1, "가"))
      .toEqual({ erase: 1, text: "가" });
    expect(input.input("각", "insertFromComposition", "")).toBeNull();
    expect(input.editorValue).toBe("가");
    expect(input.input("가각", "", "")).toEqual({ erase: 0, text: "각" });
  });

  test("does not discard an indistinguishable independent edit with an empty input type", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가", "insertCompositionText", "가");
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.replaceSelectedPending("가", "가", 0, 1, "가"))
      .toEqual({ erase: 1, text: "가" });
    // Without a transaction type or data, this can also be a new soft edit.
    expect(input.input("각", "", "")).toEqual({ erase: 1, text: "각" });
  });

  test("a late composition-text echo cannot revert a selected independent replacement", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.replaceSelectedPending("가", "가", 0, 1, "가"))
      .toEqual({ erase: 1, text: "가" });
    expect(input.input("각", "insertCompositionText", "각")).toBeNull();
    expect(input.editorValue).toBe("가");
    expect(input.input("가각", "insertText", "각")).toEqual({ erase: 0, text: "각" });
  });

  test("a selected provisional replacement must erase even if its new character equals the committed character", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가", "insertCompositionText", "가");
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.replaceSelectedPending("각", "가", 0, 1, "각")).toEqual({ erase: 1, text: "각" });
    expect(input.input("각", "insertFromComposition", "각")).toBeNull();
    expect(input.editorValue).toBe("각");
  });
  test("a selected soft suffix replacement retains the confirmed IME prefix", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가나", "insertCompositionText", "가나")).toBeNull();
    expect(input.compositionEnd("가나", "각낙")).toEqual({ erase: 0, text: "각낙" });
    expect(input.replaceSelectedPending("가다", "가나", 1, 2, "다"))
      .toEqual({ erase: 1, text: "다" });
    expect(input.editorValue).toBe("각다");
    expect(input.input("각낙", "insertCompositionText", "각낙")).toBeNull();
    expect(input.editorValue).toBe("각다");
    // Terminal restores the textarea to the confirmed editor after a late echo.
    expect(input.input("각다x", "insertText", "x")).toEqual({ erase: 0, text: "x" });
    expect(input.editorValue).toBe("각다x");
  });

  test("an unmappable selected IME suffix never deletes an unknown confirmed prefix", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가나", "insertCompositionText", "가나");
    expect(input.compositionEnd("가나", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.replaceSelectedPending("가다", "가나", 1, 2, "다"))
      .toEqual({ erase: 0, text: "" });
    expect(input.editorValue).toBe("각");
    // Only an old IME echo is pending; the native textarea can be restored.
    expect(input.hasPendingCommit).toBe(false);
    expect(input.input("각각", "insertCompositionText", "각")).toBeNull();
    expect(input.editorValue).toBe("각");
    expect(input.input("각x", "insertText", "x")).toEqual({ erase: 0, text: "x" });
  });

  test("a rejected partial IME selection still ignores its late explicit echo after unrelated physical and soft text", () => {
    for (const inputType of ["insertCompositionText", "insertFromComposition"]) {
      const input = new AndroidTextDelta();
      input.compositionStart();
      expect(input.input("가나", "insertCompositionText", "가나")).toBeNull();
      expect(input.compositionEnd("가나", "각")).toEqual({ erase: 0, text: "각" });
      expect(input.replaceSelectedPending("가다", "가나", 1, 2, "다"))
        .toEqual({ erase: 0, text: "" });
      input.noteIndependentKey("x");
      expect(input.input("각x", "insertText", "x")).toEqual({ erase: 0, text: "x" });
      expect(input.input("각xy", "insertText", "y")).toEqual({ erase: 0, text: "y" });
      expect(input.input("각xy각", inputType, "각")).toBeNull();
      expect(input.editorValue).toBe("각xy");
      expect(input.input("각xy각", "insertText", "각")).toEqual({ erase: 0, text: "각" });
    }
  });

  test("a late explicit IME echo can precede a distinct physical key's native input", () => {
    for (const inputType of ["insertFromComposition", "insertCompositionText"]) {
      const input = new AndroidTextDelta();
      input.compositionStart();
      expect(input.input("가나", "insertCompositionText", "가나")).toBeNull();
      expect(input.compositionEnd("가나", "각")).toEqual({ erase: 0, text: "각" });
      expect(input.replaceSelectedPending("가다", "가나", 1, 2, "다"))
        .toEqual({ erase: 0, text: "" });
      input.noteIndependentKey("x");
      expect(input.input("각각", inputType, "각")).toBeNull();
      expect(input.editorValue).toBe("각");
      expect(input.input("각x", "insertText", "x")).toEqual({ erase: 0, text: "x" });
    }
  });

  test("an independent physical candidate identical to the old IME word is not discarded", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가나", "insertCompositionText", "가나");
    expect(input.compositionEnd("가나", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.replaceSelectedPending("가다", "가나", 1, 2, "다"))
      .toEqual({ erase: 0, text: "" });
    input.noteIndependentKey("각");
    expect(input.input("각각", "insertCompositionText", "각")).toEqual({ erase: 0, text: "각" });
  });

  test("recognizes an already-final cumulative word when input data is incremental", () => {
    const input = new AndroidTextDelta();
    input.input("n", "insertText");
    input.compositionStart();
    expect(input.input("nv", "insertCompositionText", "v")).toEqual({ erase: 0, text: "v" });
    expect(input.compositionEnd("nv", "nv")).toBeNull();
    expect(input.editorValue).toBe("nv");
  });

  test("derives a marked edit from DOM changes when insertCompositionText has no data", () => {
    for (const before of ["", "abc"]) {
      const input = new AndroidTextDelta();
      if (before) input.input(before, "insertText");
      input.compositionStart();
      expect(input.input(before + "n", "insertCompositionText", "")).toEqual({ erase: 0, text: "n" });
      expect(input.compositionEnd(before + "n", "nv")).toEqual({ erase: 0, text: "v" });
      expect(input.editorValue).toBe(before + "nv");
    }
  });

  test("does not duplicate the prior word when the final composition shrinks or extends unseen text", () => {
    for (const [final, expected] of [["n", { erase: 1, text: "" }], ["nvi", { erase: 0, text: "i" }]] as const) {
      const input = new AndroidTextDelta();
      input.input("n", "insertText");
      input.compositionStart();
      expect(input.input("nv", "insertCompositionText", "v")).toEqual({ erase: 0, text: "v" });
      expect(input.compositionEnd("nv", final)).toEqual(expected);
      expect(input.editorValue).toBe(final);
    }
  });
  test("canceled IME text identifies the marked candidate, not the already-sent editor prefix", () => {
    const input = new AndroidTextDelta();
    input.input("x", "insertText", "x");
    input.compositionStart();
    expect(input.input("x가", "insertCompositionText", "가")).toBeNull();
    expect(input.markedCompositionText).toBe("가");
  });

  test("a composing insertText without a marked span still identifies its canceled candidate", () => {
    const input = new AndroidTextDelta();
    input.input("x", "insertText", "x");
    input.compositionStart();
    expect(input.input("x가", "insertText", "가")).toBeNull();
    expect(input.markedCompositionText).toBe("가");
  });

  test("a canceled candidate with only a prefix of already reported physical keys is not committed", () => {
    expect(isCanceledAndroidCompositionValue("가q", "", "가", "가", "qr")).toBe(true);
    expect(isCanceledAndroidCompositionValue("가qr", "", "가", "가", "qr")).toBe(true);
    expect(isCanceledAndroidCompositionValue("가q", "q", "가", "x가", "qr")).toBe(true);
    expect(isCanceledAndroidCompositionValue("qx가q", "qx", "가", "x가", "qr")).toBe(true);
    expect(isCanceledAndroidCompositionValue("가s", "", "가", "가", "qr")).toBe(false);
    expect(isCanceledAndroidCompositionValue("각q", "", "가", "가", "qr")).toBe(false);
  });
  test("deferred Kitty composition sends its ASCII precursor and CJK candidate in final editor order", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.deferComposingText();
    expect(input.input("a", "insertCompositionText", "a")).toBeNull();
    expect(input.input("가a", "insertCompositionText", "가a")).toBeNull();
    expect(input.compositionEnd("가a", "가a")).toEqual({ erase: 0, text: "가a" });
    expect(input.editorValue).toBe("가a");
  });
  test("a deferred physical key surviving an empty IME commit still reaches the remote PTY", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.deferComposingText();
    input.noteDeferredPhysicalKey("a");
    expect(input.input("a", "insertCompositionText", "a")).toBeNull();
    expect(input.compositionEnd("a", "")).toEqual({ erase: 0, text: "a" });
    expect(input.editorValue).toBe("a");
  });

  test("shrinks a multi-character previously composed word instead of appending the candidate", () => {
    const input = new AndroidTextDelta();
    input.input("nvi", "insertText");
    input.compositionStart();
    expect(input.input("nvim", "insertCompositionText", "m")).toEqual({ erase: 0, text: "m" });
    expect(input.compositionEnd("nvim", "nv")).toEqual({ erase: 2, text: "" });
    expect(input.editorValue).toBe("nv");
  });

  test("Backspace after a shorter final candidate deletes one committed character, not a ghost suffix", () => {
    const input = new AndroidTextDelta();
    input.input("nvi", "insertText");
    input.compositionStart();
    input.input("nvim", "insertCompositionText", "m");
    input.compositionEnd("nvim", "nv");
    expect(input.input("nvi", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(input.editorValue).toBe("n");
    expect(input.input("nv", "", "nv")).toBeNull();
    expect(input.editorValue).toBe("n");
  });

  test("uses the selected marked character when unchanged text repeats", () => {
    for (const [start, expected] of [[0, "ba"], [1, "ab"]] as const) {
      const input = new AndroidTextDelta();
      input.input("aa", "insertText");
      input.compositionStart(start, start + 1);
      input.compositionUpdate("a", "aa");
      input.compositionEnd("aa", "b");
      expect(input.editorValue).toBe(expected);
    }
  });

  test("does not consume unselected suffix when final data extends selected text", () => {
    for (const [editor, start, final, expected] of [["abc", 1, "bc", "abcc"], ["abab", 2, "ab", "ababb"]] as const) {
      const input = new AndroidTextDelta();
      input.input(editor, "insertText");
      input.compositionStart(start, start + 1);
      input.compositionUpdate(editor[start], editor);
      input.compositionEnd(editor, final);
      expect(input.editorValue).toBe(expected);
    }
  });

  test("expands a selected marked span while retaining the original repeated suffix", () => {
    const input = new AndroidTextDelta();
    input.input("ab", "insertText");
    input.compositionStart(0, 1);
    input.input("abb", "insertCompositionText", "ab");
    input.compositionEnd("abb", "가");
    expect(input.editorValue).toBe("가b");
  });

  test("Backspace after a selected middle correction deletes the committed suffix once", () => {
    const input = new AndroidTextDelta();
    input.input("abbb", "insertText");
    input.compositionStart(1, 3);
    input.compositionUpdate("bb", "abbb");
    input.compositionEnd("abbb", "b");
    expect(input.editorValue).toBe("abb");
    expect(input.input("abb", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(input.editorValue).toBe("ab");
  });

  test("selected text expands around a retained suffix without IME data payload", () => {
    const input = new AndroidTextDelta();
    input.input("ab", "insertText");
    input.compositionStart(0, 1);
    input.input("abb", "insertCompositionText", "");
    input.compositionEnd("abb", "가");
    expect(input.editorValue).toBe("가b");
  });

  test("tracks corrections and deletes full Unicode scalar values", () => {
    const input = new AndroidTextDelta();
    expect(input.input("ab", "insertText")).toEqual({ erase: 0, text: "ab" });
    expect(input.input("ax", "insertReplacementText")).toEqual({ erase: 1, text: "x" });
    expect(input.input("a", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(input.input("a😀", "insertText")).toEqual({ erase: 0, text: "😀" });
    expect(input.input("a😁", "insertReplacementText")).toEqual({ erase: 1, text: "😁" });
  });

  test("defers uncommitted CJK edits but corrects already emitted ASCII on replacement", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("ㅎ", "insertCompositionText")).toBeNull();
    expect(input.input("가", "insertCompositionText")).toBeNull();
    expect(input.compositionEnd("가")).toEqual({ erase: 0, text: "가" });
    input.compositionStart();
    expect(input.input("가n", "insertCompositionText")).toEqual({ erase: 0, text: "n" });
    expect(input.input("가你", "insertCompositionText")).toBeNull();
    expect(input.compositionEnd("가你")).toEqual({ erase: 1, text: "你" });
  });

  test("cancels deferred composition without sending provisional text", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "")).toBeNull();
    expect(input.editorValue).toBe("");
    expect(input.input("", "deleteCompositionText")).toBeNull();
  });

  test("uses the final composition payload when the DOM is still provisional", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.editorValue).toBe("각");
    expect(input.input("각", "", "각")).toBeNull();
  });

  test("cancels already-sent ASCII against its composition start without losing earlier text", () => {
    const input = new AndroidTextDelta();
    expect(input.input("x", "insertText")).toEqual({ erase: 0, text: "x" });
    input.compositionStart();
    expect(input.input("xn", "insertCompositionText", "n")).toEqual({ erase: 0, text: "n" });
    expect(input.compositionEnd("xn", "")).toEqual({ erase: 1, text: "" });
    expect(input.editorValue).toBe("x");
    expect(input.input("xv", "insertText")).toEqual({ erase: 0, text: "v" });
  });

  test("commits a changed marked ASCII word only once", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("n", "insertCompositionText", "n")).toEqual({ erase: 0, text: "n" });
    expect(input.compositionEnd("n", "nv")).toEqual({ erase: 0, text: "v" });
    expect(input.editorValue).toBe("nv");
    expect(input.input("nv", "insertText")).toBeNull();
  });

  test("commits a marked edit in the middle without emitting provisional text", () => {
    const input = new AndroidTextDelta();
    expect(input.input("ab", "insertText")).toEqual({ erase: 0, text: "ab" });
    input.compositionStart();
    expect(input.input("a가b", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("a가b", "각")).toEqual({ erase: 1, text: "각b" });
    expect(input.hasPendingCommit).toBe(true);
    expect(input.input("a각b", "insertText", "각")).toBeNull();
    expect(input.hasPendingCommit).toBe(false);
  });

  test("recognizes a native completion inserted inside the marked range", () => {
    const input = new AndroidTextDelta();
    input.input("ab", "insertText");
    input.compositionStart();
    input.input("a가b", "insertCompositionText", "가");
    input.compositionEnd("a가b", "각");
    expect(input.input("a가각b", "", "각")).toBeNull();
    expect(input.editorValue).toBe("a각b");
    expect(input.hasPendingCommit).toBe(false);
  });

  test("reconciles an IME completion append without consuming independent text", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.hasPendingCommit).toBe(true);
    expect(input.input("가각", "", "각")).toBeNull();
    expect(input.editorValue).toBe("각");
    expect(input.hasPendingCommit).toBe(false);
    input.reset();
    input.compositionStart();
    input.input("가", "insertCompositionText", "가");
    input.compositionEnd("가", "각");
    expect(input.input("가각", "insertText", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.editorValue).toBe("각각");
  });

  test("recognizes full-word native completion even after trimming a shared prefix", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("n", "insertCompositionText", "n");
    expect(input.compositionEnd("n", "nv")).toEqual({ erase: 0, text: "v" });
    expect(input.input("nnv", "", "nv")).toBeNull();
    expect(input.editorValue).toBe("nv");
  });

  test("one independent Backspace before native completion deletes only one committed character", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("n", "insertCompositionText", "n");
    input.compositionEnd("n", "nv");
    expect(input.input("", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(input.editorValue).toBe("n");
    expect(input.input("nv", "", "nv")).toBeNull();
    expect(input.editorValue).toBe("n");
  });

  test("a second Backspace before native completion removes the next committed character", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("n", "insertCompositionText", "n");
    input.compositionEnd("n", "nv");
    input.input("", "deleteContentBackward");
    expect(input.input("", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(input.editorValue).toBe("");
    expect(input.input("nv", "", "nv")).toBeNull();
    expect(input.editorValue).toBe("");
  });

  test("late native suffix echo does not resurrect a character deleted before completion", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("n", "insertCompositionText", "n");
    input.compositionEnd("n", "nv");
    input.input("", "deleteContentBackward");
    expect(input.input("v", "", "v")).toBeNull();
    expect(input.editorValue).toBe("n");
  });

  test("does not discard an independently keyed letter with an unspecified inputType", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가", "insertCompositionText", "가");
    input.compositionEnd("가", "각");
    input.noteIndependentKey();
    expect(input.input("가각", "", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.editorValue).toBe("각각");
  });

  test("does not consume an independent keyed character that happens to equal the pending final", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("n", "insertCompositionText", "n");
    input.compositionEnd("n", "nv");
    input.noteIndependentKey();
    expect(input.input("nv", "insertText", "v")).toEqual({ erase: 0, text: "v" });
    expect(input.editorValue).toBe("nvv");
  });

  test("an independent soft candidate after unrelated text is never swallowed as old native cleanup", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.input("가x", "insertText", "x")).toEqual({ erase: 0, text: "x" });
    expect(input.input("각x각", "", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.editorValue).toBe("각x각");
  });

  test("ordinary soft-key insertText remains independent without a keydown", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("n", "insertCompositionText", "n");
    input.compositionEnd("n", "nv");
    expect(input.input("nv", "insertText", "v")).toEqual({ erase: 0, text: "v" });
    expect(input.editorValue).toBe("nvv");
  });

  test("preserves a different final candidate from a native completion input", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가", "insertCompositionText", "가");
    input.compositionEnd("가", "각");
    expect(input.input("나", "", "나")).toEqual({ erase: 1, text: "나" });
    expect(input.editorValue).toBe("나");
  });

  test("waits through native composition cleanup before the final insert", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    input.input("가", "insertCompositionText", "가");
    expect(input.compositionEnd("가", "각")).toEqual({ erase: 0, text: "각" });
    expect(input.input("", "deleteCompositionText")).toBeNull();
    expect(input.hasPendingCommit).toBe(true);
    expect(input.input("각", "", "각")).toBeNull();
    expect(input.hasPendingCommit).toBe(false);
  });

  test("split native cleanup inserts a candidate and surviving physical tail only once", () => {
    for (const base of ["", "x"]) for (const suffix of ["a", "ab", "😀"]) for (const cleanupType of ["deleteCompositionText", ""]) {
      const input = new AndroidTextDelta();
      if (base) input.input(base, "insertText", base);
      input.compositionStart();
      input.input(base + "가", "insertCompositionText", "가");
      let native = base + "가";
      for (const key of suffix) {
        input.noteIndependentKey(key);
        native += key;
        input.input(native, "insertCompositionText", key);
      }
      expect(input.compositionEnd(native, "각")).toEqual({ erase: 0, text: "각" });
      expect(input.input(base, cleanupType)).toBeNull();
      expect(input.hasPendingCommit).toBe(true);
      expect(input.input(base + "각" + suffix, cleanupType ? "insertFromComposition" : "", "각")).toEqual({ erase: 0, text: suffix });
      expect(input.editorValue).toBe(base + "각" + suffix);
      expect(input.hasPendingCommit).toBe(false);
    }
  });

  test("keeps distinct edits after a provisional DOM value until native completion", () => {
    const input = new AndroidTextDelta();
    input.input("ab", "insertText");
    input.compositionStart();
    input.input("a가b", "insertCompositionText", "가");
    input.compositionEnd("a가b", "각");
    expect(input.input("a가bx", "insertText", "x")).toEqual({ erase: 0, text: "x" });
    expect(input.editorValue).toBe("a각bx");
    expect(input.hasPendingCommit).toBe(false);
  });

  test("preserves the old character when canceling a marked replacement", () => {
    const input = new AndroidTextDelta();
    input.input("n", "insertText");
    input.compositionStart();
    expect(input.input("nv", "insertCompositionText", "nv")).toEqual({ erase: 0, text: "v" });
    expect(input.compositionEnd("nv", "")).toEqual({ erase: 1, text: "" });
    expect(input.input("na", "insertText", "a")).toEqual({ erase: 0, text: "a" });
    expect(input.editorValue).toBe("na");
  });

  test("canceling a selected candidate retains a physical suffix restored by the native editor", () => {
    const input = new AndroidTextDelta();
    expect(input.input("a", "insertText")).toEqual({ erase: 0, text: "a" });
    input.compositionStart(0, 1);
    expect(input.input("中", "insertCompositionText", "中")).toBeNull();
    input.noteIndependentKey("b"); // Kitty already reported physical b.
    expect(input.input("中b", "insertCompositionText", "b")).toBeNull();
    expect(input.compositionEnd("ab", "")).toBeNull(); // Physical b already reached SSH.
    expect(input.editorValue).toBe("ab");
  });

  test("an empty original editor keeps only a physically reported suffix surviving cancellation", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("中", "insertCompositionText", "中")).toBeNull();
    input.noteIndependentKey("b");
    expect(input.input("中b", "insertCompositionText", "b")).toBeNull();
    expect(input.compositionEnd("b", "")).toBeNull();
    expect(input.editorValue).toBe("b");
    input.reset();
    input.compositionStart();
    expect(input.input("中", "insertCompositionText", "中")).toBeNull();
    input.noteIndependentKey("b");
    expect(input.input("中b", "insertCompositionText", "b")).toBeNull();
    expect(input.compositionEnd("", "")).toBeNull();
    expect(input.editorValue).toBe("");
  });

  test("canceling only one of two physical repeats retains the surviving native suffix", () => {
    for (const original of ["", "a"]) {
      const input = new AndroidTextDelta();
      if (original) input.input(original, "insertText");
      input.compositionStart(0, original.length);
      expect(input.input("中", "insertCompositionText", "中")).toBeNull();
      input.noteIndependentKey("b");
      expect(input.input("中b", "insertCompositionText", "b")).toBeNull();
      input.noteIndependentKey("b");
      expect(input.input("中bb", "insertCompositionText", "b")).toBeNull();
      expect(input.compositionEnd(original + "b", "")).toBeNull();
      expect(input.editorValue).toBe(original + "b");
    }
  });

  test("late native candidate replacement restores surviving physical suffix instead of losing it", () => {
    for (const suffix of ["a", "aa", "ab", "a😀", "😀"]) {
      const input = new AndroidTextDelta();
      input.compositionStart();
      expect(input.input("가", "insertCompositionText", "가")).toBeNull();
      let native = "가";
      for (const key of suffix) {
        input.noteIndependentKey(key);
        native += key;
        expect(input.input(native, "insertCompositionText", key)).toBeNull();
      }
      expect(input.compositionEnd(native, "각")).toEqual({ erase: 0, text: "각" });
      expect(input.editorValue).toBe("각");
      expect(input.input("각" + suffix, "insertFromComposition", "각")).toEqual({ erase: 0, text: suffix });
      expect(input.editorValue).toBe("각" + suffix);
      expect(input.hasPendingCommit).toBe(false);
      expect(input.input("각" + suffix, "insertFromComposition", "각")).toBeNull();
    }
  });

  test("reset forgets textarea history after an editing boundary", () => {
    const input = new AndroidTextDelta();
    expect(input.input("nvim", "insertText")).toEqual({ erase: 0, text: "nvim" });
    input.reset();
    expect(input.input("n", "insertText")).toEqual({ erase: 0, text: "n" });
  });

  test("trims old editor context without replaying its suffix", () => {
    const input = new AndroidTextDelta();
    const longValue = "x".repeat(513);
    expect(input.input(longValue, "insertText")).toEqual({ erase: 0, text: longValue });
    expect(input.compact()).toBe("x".repeat(128));
    expect(input.input("x".repeat(128) + "y", "insertText")).toEqual({ erase: 0, text: "y" });
  });
});

describe("Android remote text origin", () => {
  test("only a reported physical character can be erased by a native-only Backspace", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    expect(origins.reportedDeletes("")).toBe(1);
    origins.sync("");
    origins.sync("a"); // An input-only software key emitted no Kitty press.
    expect(origins.reportedDeletes("")).toBe(0);
    origins.sync("");
  });

  test("text sent before a Kitty mode switch remains remotely deletable", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("n", -1, -1, "", false, "n"); // Legacy text reached SSH before flags=8.
    expect(origins.reportedDeletes("")).toBe(1);
    origins.sync("");
    origins.sync("나", -1, -1, "", false, "나"); // One Unicode scalar is one DEL.
    expect(origins.reportedDeletes("")).toBe(1);
    origins.sync("");
    origins.sync("x"); // In Kitty physical-only mode, soft x was never transmitted.
    expect(origins.reportedDeletes("")).toBe(0);
  });

  test("one normalized grapheme sent to SSH must never produce two native DELs", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("é", -1, -1, "", false, "é");
    expect(origins.reportedDeletes("", 0, 2, "é")).toBe(1);
    origins.reset();
    origins.sync("가", -1, -1, "", false, "가");
    expect(origins.reportedDeletes("", 0, 2, "가")).toBe(1);
    origins.reset();
    origins.sync("xéb", -1, -1, "", false, "xéb");
    expect(origins.reportedDeletes("xé", 4, 4, "xéb")).toBe(1);
    origins.sync("xé", 4, 4, "xéb", true);
    expect(origins.reportedDeletes("x", 1, 3, "xé")).toBe(1);
  });

  test("a provisional IME candidate does not erase ownership of the original reported selection", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("a", -1, -1, "", false, "a");
    origins.startComposition();
    origins.sync("가"); // Not sent: the IME is still changing its candidate.
    expect(origins.reportedDeletes("각")).toBe(0);
    expect(origins.reportedCompositionDeletes("각")).toBe(1);
  });

  test("replacing a selected reported word erases all selected scalars even if the new word ends alike", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("ab", -1, -1, "", false, "ab");
    origins.startComposition(0, 2);
    origins.sync("中b", 0, 2, "ab"); // The native IME candidate is not remotely reported.
    expect(origins.reportedCompositionDeletes("中b")).toBe(2);
  });

  test("a selected identical native replacement still needs one remote DEL before one new glyph", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("a", -1, -1, "", false, "a");
    expect(origins.reportedDeletes("a", 0, 1, "a")).toBe(1);
    origins.sync("a", 0, 1, "a", false, "a");
    expect(origins.reportedDeletes("", 1, 1, "a")).toBe(1);
  });
  test("keeps both remote glyphs deletable when a selected equal prefix was sent as an append", () => {
    for (const glyph of ["a", "😀"]) {
      const input = new AndroidTextDelta();
      const origins = new AndroidRemoteTextOrigins();
      input.input(glyph, "insertText", glyph);
      origins.sync(glyph, -1, -1, "", false, glyph);
      const expanded = input.input(glyph + glyph, "insertText", glyph + glyph);
      expect(expanded).toEqual({ erase: 0, text: glyph });
      origins.sync(input.editorValue, 0, glyph.length, glyph, false, expanded!.text);
      for (const remaining of [glyph, ""]) {
        const before = input.editorValue;
        expect(input.input(remaining, "deleteContentBackward")).toEqual({ erase: 1, text: "" });
        expect(origins.reportedDeletes(remaining, before.length, before.length, before)).toBe(1);
        origins.sync(remaining, before.length, before.length, before, true);
      }
    }
  });

  test("partially deleting NFC-composed soft text replaces the remote grapheme", () => {
    for (const [source, remaining] of [["é", "e"], ["가", "ᄀ"]]) {
      const origins = new AndroidRemoteTextOrigins();
      origins.sync(source, -1, -1, "", false, source);
      expect(origins.normalizedTailReplacement(remaining)).toEqual({ erase: 1, text: remaining });
      expect(origins.normalizedTailReplacement("")).toBeNull(); // A whole-cluster delete already sends one DEL.
    }
  });
  test("a physical key replacing an identical selected soft glyph becomes remote-owned", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("a"); // Soft a was never transmitted.
    origins.noteKey("a");
    origins.sync("a", 0, 1, "a"); // The DOM value is unchanged after replacement.
    expect(origins.reportedDeletes("")).toBe(1);
  });
  test("a same-value selected edit keeps the already sent glyph deletable", () => {
    for (const key of ["a", "각", "😀"]) {
      const input = new AndroidTextDelta();
      const origins = new AndroidRemoteTextOrigins();
      expect(input.input(key, "insertText", key)).toEqual({ erase: 0, text: key });
      origins.sync(key, -1, -1, "", false, key);
      expect(input.input(key, "insertText", key)).toBeNull();
      origins.sync(key, 0, key.length, key);
      expect(input.input("", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
      expect(origins.reportedDeletes("", key.length, key.length, key)).toBe(1);
      origins.sync("", key.length, key.length, key, true);
    }
  });
  test("a selected native echo of a later physical key stays deletable when an earlier key has no echo", () => {
    for (const key of ["b", "각", "😀"]) {
      const origins = new AndroidRemoteTextOrigins();
      origins.sync(key); // The initial soft glyph was not reported remotely.
      origins.noteKey("a");
      origins.noteKey(key); // The remote already received a, then this key.
      expect(origins.sync(key, 0, key.length, key)).toBe(key);
      expect(origins.reportedDeletes("", key.length, key.length, key)).toBe(1);
    }
  });
  test("a late native echo of an earlier physical key is still owned after a selected later key", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("b"); // Soft b was not reported in Kitty physical-only mode.
    origins.noteKey("a");
    origins.noteKey("b"); // Remote has received both physical keys already.
    expect(origins.sync("b", 0, 1, "b")).toBe("b");
    expect(origins.sync("ba", 1, 1, "b")).toBe("a");
    expect(origins.reportedDeletes("b", 2, 2, "ba")).toBe(1);
  });

  test("an out-of-order native physical echo does not consume earlier pending keys", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.noteKey("b");
    expect(origins.sync("b")).toBe("b");
    origins.clearUnobservedKeys("b"); // b keyup must not revoke the older physical a.
    expect(origins.sync("ba")).toBe("a");
  });
  test("keyup of an observed physical repeat does not revoke a later identical press", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    expect(origins.sync("a")).toBe("a");
    origins.noteKey("a"); // The second press has not reached the native editor.
    origins.clearUnobservedKeys("a"); // Keyup belongs to the already observed first press.
    expect(origins.sync("aa")).toBe("a");
  });

  test("one keyup releases a held physical key and all its repeats before later soft text", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    expect(origins.sync("a")).toBe("a");
    origins.noteKey("a", true);
    expect(origins.sync("aa")).toBe("a");
    origins.clearUnobservedKeys("a"); // One release ends the held key, including repeat.
    origins.noteKey("a");
    origins.clearUnobservedKeys("a"); // This later press got no native edit.
    expect(origins.sync("aaa")).toBeNull(); // New soft a is not a stale physical echo.
  });
  test("physical keyup uses the original keydown glyph after Shift is released", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("A", false, "KeyA");
    origins.clearUnobservedKeys("a", "KeyA");
    expect(origins.sync("A")).toBeNull(); // A fresh soft A cannot be the released key's echo.
  });

  test("one keyup releases glyph changes within a held physical repeat", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("A", false, "KeyA");
    origins.noteKey("a", true, "KeyA");
    origins.clearUnobservedKeys("a", "KeyA");
    expect(origins.sync("Aa")).toBeNull();
  });
  test("Numpad1 keyup cannot release another observed Digit1 sharing its glyph", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("1", false, "Digit1");
    expect(origins.sync("1")).toBe("1");
    origins.noteKey("1", false, "Numpad1");
    origins.clearUnobservedKeys("1", "Numpad1");
    expect(origins.sync("11")).toBeNull(); // The second 1 is independent soft input.
    expect(origins.reportedDeletes("1")).toBe(0); // Only the first 1 was sent physically.
  });

  test("anonymous hardware keyup retires all unidentifiable outstanding glyphs", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("A", false, "");
    origins.noteKey("b", false, "");
    origins.clearUnobservedKeys("a", "");
    expect(origins.sync("Ab")).toBeNull(); // New soft text cannot be owned by either anonymous press.
  });

  test("focus handoff retires unresolved presses but keeps observed remote origins", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a", false, "KeyA");
    expect(origins.sync("a")).toBe("a");
    origins.noteKey("b", false, "KeyB");
    origins.retirePendingKeys();
    expect(origins.sync("ab")).toBeNull(); // Independent soft b after blur.
    expect(origins.reportedDeletes("", 0, 1, "ab")).toBe(1); // a remains remote-owned.
  });
  test("a physical press without a native edit cannot consume a later independent soft character", () => {
    const input = new AndroidTextDelta();
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("b"); // The physical key was already sent over SSH.
    origins.clearUnobservedKeys("b"); // Its keyup arrived without any native edit.
    const change = input.input("b", "insertText", "b");
    expect(change).toEqual({ erase: 0, text: "b" });
    expect(origins.sync(input.editorValue, 0, 0, "", false, change!.text)).toBeNull();
  });

  test("a non-tail selected IME correction must not append after a reported suffix", () => {
    const input = new AndroidTextDelta();
    const origins = new AndroidRemoteTextOrigins();
    expect(input.input("abc", "insertText")).toEqual({ erase: 0, text: "abc" });
    origins.sync("abc", -1, -1, "", false, "abc");
    expect(origins.hasReportedTextAfter(2)).toBe(true); // c survives a selected middle b.
    input.compositionStart(1, 2);
    expect(input.compositionEnd("abc", "x")).toEqual({ erase: 2, text: "xc" });
    expect(origins.hasReportedSuffixAfterEdit(input.editorValue)).toBe(true);
    input.restoreEditor(origins.editorValue); // No extra bytes may be sent to the PTY.
    expect(input.input("abcd", "insertText", "d")).toEqual({ erase: 0, text: "d" });
    expect(origins.hasReportedSuffixAfterEdit("abx")).toBe(false);
  });

  test("an unchanged selected delete does not revoke a physical origin", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    origins.sync("a", 0, 1, "a", true); // The IME did not actually edit the DOM.
    expect(origins.reportedDeletes("", 0, 1, "a")).toBe(1);
  });

  test("same glyph inserted before a physical suffix remains unreported", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    origins.sync("aa", 0, 0, "a"); // A soft a was inserted before the physical a.
    expect(origins.reportedDeletes("a", 0, 1, "aa")).toBe(0);
    origins.sync("a", 0, 1, "aa");
    expect(origins.reportedDeletes("")).toBe(1); // The remaining a was physical.
  });

  test("deletes a selected reported prefix only if no reported suffix survives", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    origins.sync("ab"); // b was inserted by a soft keyboard.
    expect(origins.reportedDeletes("b", 0, 1, "ab")).toBe(1);
    origins.sync("b");
    expect(origins.reportedDeletes("")).toBe(0);
    origins.reset();
    origins.noteKey("a");
    origins.sync("a");
    origins.sync("aa"); // Identical soft suffix cannot identify a selection via text diff.
    expect(origins.reportedDeletes("a", 0, 1, "aa")).toBe(1);
    origins.sync("a", 0, 1, "aa");
    expect(origins.reportedDeletes("")).toBe(0);
    origins.reset();
    origins.noteKey("a");
    origins.sync("a");
    origins.sync("aa");
    expect(origins.reportedDeletes("a")).toBe(0);
    origins.sync("a", -1, -1, "", true); // Some IMEs omit beforeinput.
    expect(origins.reportedDeletes("")).toBe(0); // Never erase remote text from ambiguous ownership.
    origins.reset();
    origins.sync("a"); // Soft prefix.
    origins.noteKey("a");
    origins.sync("aa", 1, 1, "a"); // Physical suffix.
    expect(origins.reportedDeletes("a")).toBe(0); // No beforeinput: either a could have been removed.
    origins.reset();
    origins.noteKey("a");
    origins.sync("a");
    origins.noteKey("b");
    origins.sync("ab");
    expect(origins.reportedDeletes("b", 0, 1, "ab")).toBe(0); // DEL would remove b, not a.
  });

  test("keeps ownership through middle edits and Unicode boundaries", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("😀a");
    origins.noteKey("b");
    origins.sync("😀ab");
    origins.sync("😀a中b");
    expect(origins.reportedDeletes("😀a中")).toBe(1);
    origins.sync("😀a中");
    expect(origins.reportedDeletes("😀a")).toBe(0);
  });

  test("retains a reported ASCII key typed during a deferred CJK candidate", () => {
    const input = new AndroidTextDelta();
    const origins = new AndroidRemoteTextOrigins();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    origins.sync("가");
    origins.noteKey("a");
    expect(input.input("가a", "insertCompositionText", "a")).toBeNull();
    origins.sync("가a"); // Native DOM updates even while CJK PTY text is deferred.
    expect(input.compositionEnd("가a", "가a")).toEqual({ erase: 0, text: "가a" });
    origins.sync(input.editorValue);
    expect(input.input("가", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(origins.reportedDeletes(input.editorValue)).toBe(1);
  });
  test("a full CJK recomposition replaces the candidate before a separately sent physical suffix", () => {
    const input = new AndroidTextDelta();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    expect(input.input("가a", "insertCompositionText", "a")).toBeNull();
    input.noteIndependentKey("a"); // The native editor matched the already-sent key.
    expect(input.compositionEnd("가a", "각a")).toEqual({ erase: 0, text: "각a" });
    expect(input.editorValue).toBe("각a");
  });
  test("CJK commit replaces the whole provisional candidate when later physical keys are canceled", () => {
    for (const [native, committed, expected] of [
      ["각a", "각a", "각a"], ["가ab", "각a", "각a"], ["가a", "각a", "각a"],
      ["각", "각", "각"], ["가ab", "각", "각"]
    ]) {
      const input = new AndroidTextDelta();
      input.compositionStart();
      expect(input.input("가", "insertCompositionText", "가")).toBeNull();
      for (const [value, key] of [["가a", "a"], ["가ab", "b"]]) {
        expect(input.input(value, "insertCompositionText", key)).toBeNull();
        input.noteIndependentKey(key);
      }
      expect(input.compositionEnd(native, committed)).toEqual({ erase: 0, text: expected });
      expect(input.editorValue).toBe(expected);
    }
  });

  test("candidate-only compositionend keeps a physical suffix already present in the final native editor", () => {
    for (const [physical, final] of [["a", "각a"], ["ab", "각a"], ["ab", "각ab"]]) {
      const input = new AndroidTextDelta();
      const origins = new AndroidRemoteTextOrigins();
      input.compositionStart();
      origins.startComposition();
      input.input("가", "insertCompositionText", "가");
      origins.sync("가");
      let native = "가";
      for (const key of physical) {
        native += key;
        origins.noteKey(key);
        input.input(native, "insertCompositionText", key);
        expect(origins.sync(native)).toBe(key);
        input.noteIndependentKey(key);
      }
      input.input(final, "insertCompositionText", "각");
      origins.sync(final);
      expect(input.compositionEnd(final, "각")).toEqual({ erase: 0, text: final });
      expect(input.editorValue).toBe(final);
      expect(origins.compositionCorrection(input.editorValue)).toBe(physical.length - (final.length - 1));
      expect(origins.unreportedCompositionText(final, final)).toBe("각");
      origins.endComposition(false);
      expect(input.input(final, "insertFromComposition", "각")).toBeNull();
      expect(input.input(final + "b", "insertText", "b")).toEqual({ erase: 0, text: "b" });
      expect(input.editorValue).toBe(final + "b");
    }
  });
  test("a mixed physical tail survives CJK candidate replacement without appending its stale marked text", () => {
    for (const keys of [["a", "a", "b"], ["a", "b", "😀"], ["a", "a", "😀"]]) {
      const input = new AndroidTextDelta();
      const origins = new AndroidRemoteTextOrigins();
      input.compositionStart();
      origins.startComposition();
      input.input("가", "insertCompositionText", "가");
      origins.sync("가");
      let native = "가";
      for (const key of keys) {
        native += key;
        origins.noteKey(key);
        input.input(native, "insertCompositionText", key);
        expect(origins.sync(native)).toBe(key);
        input.noteIndependentKey(key);
      }
      input.input("각a", "insertCompositionText", "각");
      origins.sync("각a");
      expect(input.compositionEnd("각a", "각a")).toEqual({ erase: 0, text: "각a" });
      expect(input.editorValue).toBe("각a");
      expect(origins.compositionCorrection(input.editorValue)).toBe(2);
      expect(origins.unreportedCompositionText("각a", "각a")).toBe("각");
      origins.endComposition(false);
      expect(input.input("각a", "insertFromComposition", "각a")).toBeNull();
      expect(input.input("각ac", "insertText", "c")).toEqual({ erase: 0, text: "c" });
    }
  });
  test("a canceled selected CJK composition preserves a previous physical suffix", () => {
    const input = new AndroidTextDelta();
    const origins = new AndroidRemoteTextOrigins();
    input.compositionStart();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    origins.sync("가");
    origins.noteKey("a"); // Kitty has already transmitted this physical key.
    expect(input.input("가a", "insertCompositionText", "a")).toBeNull();
    origins.sync("가a");
    input.compositionEnd("가a", "가a");
    origins.sync(input.editorValue);

    origins.startComposition(); // Snapshot the reported suffix before the IME replaces it.
    input.compositionStart(1, 2);
    expect(input.input("가中", "insertCompositionText", "中")).toBeNull();
    origins.sync("가中", 1, 2, "가a");
    expect(input.compositionEnd("가中", "")).toBeNull();
    origins.sync(input.editorValue);
    origins.endComposition(true);
    expect(input.editorValue).toBe("가a");
    expect(input.input("가", "deleteContentBackward")).toEqual({ erase: 1, text: "" });
    expect(origins.reportedDeletes(input.editorValue, 1, 2, "가a")).toBe(1);
  });

  test("a physical key canceled with a marked candidate is compensated, not its surviving suffix", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    origins.startComposition();
    origins.sync("中", 0, 1, "a");
    origins.noteKey("b");
    origins.sync("中b");
    origins.sync("a"); // Native cancellation removed both the candidate and b.
    expect(origins.endComposition(true)).toBe(1);
    expect(origins.reportedDeletes("", 0, 1, "a")).toBe(1);

    origins.reset();
    origins.noteKey("a");
    origins.sync("a");
    origins.startComposition();
    origins.sync("中", 0, 1, "a");
    origins.noteKey("b");
    origins.sync("中b");
    origins.sync("ab"); // The final native DOM retained the independent b.
    expect(origins.endComposition(true)).toBe(0);
    expect(origins.reportedDeletes("a", 1, 2, "ab")).toBe(1);
    origins.sync("a", 1, 2, "ab", true);
    expect(origins.reportedDeletes("", 0, 1, "a")).toBe(1); // The older physical a survived too.
  });

  test("only a physical key actually observed in the Android editor can be corrected at composition end", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("n", -1, -1, "", false, "n");
    origins.startComposition();
    origins.noteKey("b");
    origins.sync("nb"); // The IME really inserted the already reported physical b.
    origins.sync("n中"); // A provisional CJK candidate hides b's origin.
    expect(origins.compositionCorrection("n中")).toBe(1);
    origins.endComposition(false);

    origins.reset();
    origins.sync("n", -1, -1, "", false, "n");
    origins.startComposition();
    origins.noteKey("b"); // A Kitty command/IME-consumed key has no matching native insertion.
    origins.sync("n中");
    expect(origins.compositionCorrection("n中")).toBe(0);
  });
  test("a physical prefix survives a later CJK commit without remote DEL", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.startComposition();
    origins.noteKey("b");
    origins.sync("b");
    origins.sync("b中");
    expect(origins.compositionCorrection("b中")).toBe(0);

    origins.reset();
    origins.startComposition();
    origins.noteKey("b");
    origins.sync("b");
    origins.noteKey("c");
    origins.sync("bc");
    origins.sync("c");
    // Remote b,c cannot become c by sending one trailing DEL: that erases c.
    expect(origins.compositionCorrection("c")).toBe(0);
  });
  test("keeps a reported physical key through an intervening native CJK candidate", () => {
    const input = new AndroidTextDelta();
    const origins = new AndroidRemoteTextOrigins();
    input.compositionStart();
    origins.startComposition();
    expect(input.input("가", "insertCompositionText", "가")).toBeNull();
    origins.sync("가");
    origins.noteKey("a"); // Kitty sent CSI 97 u; native a is delayed.
    expect(input.input("각", "insertCompositionText", "각")).toBeNull();
    expect(origins.sync("각")).toBeNull();
    expect(input.input("각a", "insertCompositionText", "a")).toBeNull();
    expect(origins.sync("각a")).toBe("a");
    input.noteIndependentKey("a");
    const committed = input.compositionEnd("각a", "각a");
    expect(committed).toEqual({ erase: 0, text: "각a" });
    expect(origins.unreportedCompositionText(committed!.text, input.editorValue)).toBe("각");
  });

  test("a mixed IME commit excludes only physical ASCII still owned by the editor", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.startComposition();
    origins.sync("가"); // Native CJK candidate has not been sent yet.
    origins.noteKey("a"); // CSI 97 u was already sent by physical keydown.
    origins.sync("가a");
    expect(origins.unreportedCompositionText("가a", "가a")).toBe("가");
    // The IME changed only the CJK candidate at compositionend, not the
    // physical a that is still present as the native editor suffix.
    expect(origins.unreportedCompositionText("각a", "각a")).toBe("각");
    origins.endComposition(false);

    origins.reset();
    origins.startComposition();
    origins.sync("가a"); // No independent physical key was observed in the editor.
    expect(origins.unreportedCompositionText("가a", "가a")).toBe("가a");
  });

  test("a CJK prefix can precede a surviving physical key while its trailing key is canceled", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.startComposition();
    origins.sync("가");
    origins.noteKey("a");
    origins.sync("가a");
    origins.noteKey("b");
    origins.sync("가ab");
    expect(origins.compositionCorrection("가a")).toBe(1); // Only the trailing b can be erased.
    expect(origins.unreportedCompositionText("가a", "가a")).toBe("가");
  });
  test("cancellation keeps a surviving physical prefix before removing its tail", () => {
    const input = new AndroidTextDelta();
    const origins = new AndroidRemoteTextOrigins();
    input.compositionStart();
    origins.startComposition();
    for (const key of ["a", "b"]) {
      origins.noteKey(key);
      input.noteIndependentKey(key);
      const value = input.editorValue + key;
      input.input(value, "insertCompositionText", key);
      origins.sync(value);
    }
    expect(input.compositionEnd("a", "")).toEqual({ erase: 1, text: "" });
    expect(input.editorValue).toBe("a");
    expect(origins.compositionCorrection(input.editorValue)).toBe(1);
  });
  test("candidate recomposition preserves a physical prefix of a canceled native tail", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.startComposition();
    origins.sync("가");
    for (const [key, value] of [["a", "가a"], ["b", "가ab"]]) {
      origins.noteKey(key);
      expect(origins.sync(value)).toBe(key);
    }
    expect(origins.compositionCorrection("각a")).toBe(1);
    expect(origins.unreportedCompositionText("각a", "각a")).toBe("각");
    origins.sync("각a", -1, -1, "", false, "각");
    expect(origins.unreportedCompositionText("각a", "각a")).toBe("각");
    origins.endComposition(false);
    expect(origins.reportedDeletes("각")).toBe(1);

    const soft = new AndroidRemoteTextOrigins();
    soft.startComposition();
    soft.sync("가ab");
    expect(soft.unreportedCompositionText("각a", "각a")).toBe("각a");
  });
  test("a supplementary-plane physical key is one reported scalar across CJK recomposition", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.sync("x", -1, -1, "", false, "x");
    origins.startComposition();
    origins.sync("x가");
    origins.noteKey("😀");
    expect(origins.sync("x가😀")).toBe("😀");
    expect(origins.compositionCorrection("x각😀")).toBe(0);
    expect(origins.unreportedCompositionText("각😀", "x각😀")).toBe("각");
    origins.sync("x각😀", -1, -1, "", false, "각");
    expect(origins.unreportedCompositionText("각😀", "x각😀")).toBe("각");
    origins.endComposition(false);
    expect(origins.reportedDeletes("x각")).toBe(1);

    const canceled = new AndroidRemoteTextOrigins();
    canceled.sync("x", -1, -1, "", false, "x");
    canceled.startComposition();
    canceled.sync("x가");
    canceled.noteKey("😀");
    canceled.sync("x가😀");
    expect(canceled.compositionCorrection("x각")).toBe(1);
  });

  test("matches physical repeats and Unicode keys grouped in one native edit without reporting them twice", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey(" ");
    origins.noteKey(" ");
    expect(origins.sync("  ")).toBe("  ");
    expect(origins.reportedDeletes(" ", 2, 2, "  ")).toBe(1);
    origins.reset();
    origins.noteKey(" ");
    origins.noteKey(" ");
    expect(origins.sync(" ")).toBe(" ");
    expect(origins.sync("  ")).toBe(" ");
    origins.reset();
    origins.noteKey("a");
    origins.noteKey("😀");
    expect(origins.sync("a😀")).toBe("a😀");
    expect(origins.reportedDeletes("a")).toBe(1);
  });

  test("committed and reset compositions never resurrect a physical key", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    origins.startComposition();
    origins.sync("中", 0, 1, "a");
    origins.endComposition(false); // A committed replacement removes a's origin.
    expect(origins.reportedDeletes("")).toBe(0);
    origins.reset();
    origins.noteKey("a");
    origins.sync("a");
    origins.startComposition();
    origins.sync("中", 0, 1, "a");
    origins.reset();
    origins.sync("a");
    origins.endComposition(true);
    expect(origins.reportedDeletes("")).toBe(0);
  });

  test("drops a physical prefix when compacting a repeated soft-only suffix", () => {
    const origins = new AndroidRemoteTextOrigins();
    origins.noteKey("a");
    origins.sync("a");
    origins.sync("a".repeat(513));
    origins.compact("a".repeat(128));
    for (let length = 128; length > 0; length--) {
      expect(origins.reportedDeletes("a".repeat(length - 1))).toBe(0);
      origins.sync("a".repeat(length - 1));
    }
  });
});
