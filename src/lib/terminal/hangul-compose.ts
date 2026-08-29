/**
 * Hangul composition for streaming IME input.
 *
 * macOS WKWebView delivers Korean IME text in inconsistent shapes depending
 * on version and timing: lone compatibility Jamo deltas ("ㅎ", "ㅏ", "ㄴ"),
 * full-buffer resends of the in-progress syllable ("ㅎ" → "하" → "한"), or
 * one composed syllable per commit. This module reassembles every shape into
 * composed syllables before the bytes reach the PTY, and reports the minimal
 * DEL correction when a previously sent character had to change.
 */

const CHOSEONG: string[] = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

const JUNGSEONG: string[] = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
  "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ",
  "ㅣ",
];

const JONGSEONG: string[] = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ",
  "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

const CHOSEONG_MAP = new Map<string, number>(
  CHOSEONG.map((ch, i) => [ch, i])
);
const JUNGSEONG_MAP = new Map<string, number>(
  JUNGSEONG.map((ch, i) => [ch, i])
);
const JONGSEONG_MAP = new Map<string, number>(
  JONGSEONG.slice(1).map((ch, i) => [ch, i + 1])
);

const HANGUL_SYLLABLE_BASE = 0xac00;
const JUNGSEONG_COUNT = 21;

/** Consecutive consonant keystrokes that merge into a tense consonant. */
const CHO_MERGE = new Map<string, string>([
  ["ㄱ", "ㄲ"],
  ["ㄷ", "ㄸ"],
  ["ㅂ", "ㅃ"],
  ["ㅅ", "ㅆ"],
  ["ㅈ", "ㅉ"],
]);

/** Vowel keystroke that merges into the previous syllable's vowel (가 + ㅣ → 개). */
const JUNG_MERGE = new Map<string, string>([
  ["ㅗㅏ", "ㅘ"],
  ["ㅗㅐ", "ㅙ"],
  ["ㅗㅣ", "ㅚ"],
  ["ㅜㅓ", "ㅝ"],
  ["ㅜㅔ", "ㅞ"],
  ["ㅜㅣ", "ㅟ"],
  ["ㅡㅣ", "ㅢ"],
  ["ㅏㅣ", "ㅐ"],
  ["ㅓㅣ", "ㅔ"],
]);

/** Final-consonant cluster keystrokes: prevJong + next jamo → merged jong. */
const JONG_MERGE = new Map<string, string>([
  ["ㄱㄱ", "ㄲ"],
  ["ㄱㅅ", "ㄳ"],
  ["ㄴㅈ", "ㄵ"],
  ["ㄴㅎ", "ㄶ"],
  ["ㄹㄱ", "ㄺ"],
  ["ㄹㅁ", "ㄻ"],
  ["ㄹㅂ", "ㄼ"],
  ["ㄹㅅ", "ㄽ"],
  ["ㄹㅌ", "ㄾ"],
  ["ㄹㅍ", "ㄿ"],
  ["ㄹㅎ", "ㅀ"],
  ["ㅂㅅ", "ㅄ"],
  ["ㅅㅅ", "ㅆ"],
]);

/**
 * How a jongseong splits when a vowel follows: [kept jong, new choseong].
 * Plain consonants detach entirely; clusters keep their first component.
 */
const JONG_SPLIT = new Map<string, [string, string]>([
  ["ㄱ", ["", "ㄱ"]],
  ["ㄲ", ["ㄱ", "ㄱ"]],
  ["ㄴ", ["", "ㄴ"]],
  ["ㄳ", ["ㄱ", "ㅅ"]],
  ["ㄷ", ["", "ㄷ"]],
  ["ㄹ", ["", "ㄹ"]],
  ["ㄺ", ["ㄹ", "ㄱ"]],
  ["ㄻ", ["ㄹ", "ㅁ"]],
  ["ㄼ", ["ㄹ", "ㅂ"]],
  ["ㄽ", ["ㄹ", "ㅅ"]],
  ["ㄾ", ["ㄹ", "ㅌ"]],
  ["ㄿ", ["ㄹ", "ㅍ"]],
  ["ㅀ", ["ㄹ", "ㅎ"]],
  ["ㅁ", ["", "ㅁ"]],
  ["ㅂ", ["", "ㅂ"]],
  ["ㅄ", ["ㅂ", "ㅅ"]],
  ["ㅅ", ["", "ㅅ"]],
  ["ㅆ", ["ㅅ", "ㅅ"]],
  ["ㅇ", ["", "ㅇ"]],
  ["ㅈ", ["", "ㅈ"]],
  ["ㅊ", ["", "ㅊ"]],
  ["ㅋ", ["", "ㅋ"]],
  ["ㅌ", ["", "ㅌ"]],
  ["ㅍ", ["", "ㅍ"]],
  ["ㅎ", ["", "ㅎ"]],
]);

interface Syllable {
  kind: "syllable";
  cho: string;
  jung: string;
  jong: string;
  /** How many raw stream characters this unit consumed. */
  span: number;
}
interface Lone {
  kind: "lone";
  ch: string;
  span: number;
}
type Part = Syllable | Lone;

function syllableFrom(
  cho: string,
  jung: string,
  jong: string
): Omit<Syllable, "span"> | null {
  const choIdx = CHOSEONG_MAP.get(cho);
  const jungIdx = JUNGSEONG_MAP.get(jung);
  if (choIdx === undefined || jungIdx === undefined) return null;
  const jongIdx = jong ? JONGSEONG_MAP.get(jong) : undefined;
  if (jong && jongIdx === undefined) return null;
  const code =
    HANGUL_SYLLABLE_BASE + (choIdx * JUNGSEONG_COUNT + jungIdx) * 28 + (jongIdx ?? 0);
  return { kind: "syllable", cho, jung, jong };
}

function decomposeChar(ch: string): string[] | null {
  if (CHOSEONG_MAP.has(ch) || JUNGSEONG_MAP.has(ch)) return [ch];
  const code = ch.codePointAt(0)! - HANGUL_SYLLABLE_BASE;
  if (code < 0 || code > 11171) return null;
  const jong = code % 28;
  const jung = Math.floor(code / 28) % JUNGSEONG_COUNT;
  const cho = Math.floor(code / 28 / JUNGSEONG_COUNT);
  const parts = [CHOSEONG[cho], JUNGSEONG[jung]];
  if (jong) parts.push(JONGSEONG[jong]);
  return parts;
}

function isHangulChar(ch: string): boolean {
  return (
    CHOSEONG_MAP.has(ch) ||
    JUNGSEONG_MAP.has(ch) ||
    JONGSEONG_MAP.has(ch) ||
    (ch.codePointAt(0)! >= HANGUL_SYLLABLE_BASE &&
      ch.codePointAt(0)! <= HANGUL_SYLLABLE_BASE + 11171)
  );
}

/**
 * Recompose a raw stream of Jamo and/or composed syllables into syllables,
 * merging keystrokes that extend the previous unit (tense consonants,
 * compound vowels, jongseong attach, jongseong clusters).
 */
function buildParts(raw: string): Part[] {
  const parts: Part[] = [];

  for (const ch of raw) {
    const last = parts.at(-1);
    const isJongCapable = JONGSEONG_MAP.has(ch) && !JUNGSEONG_MAP.has(ch);

    // Jong first: a consonant keystroke attaches as final consonant when
    // the previous syllable can take one (ㄱㄴㄷ… are cho+jong dual use).
    if (isJongCapable && last && last.kind === "syllable" && !last.jong) {
      const s = syllableFrom(last.cho, last.jung, ch);
      if (s) {
        parts[parts.length - 1] = { ...s, span: last.span + 1 };
        continue;
      }
    }
    if (isJongCapable && last && last.kind === "syllable" && last.jong) {
      const merged = JONG_MERGE.get(last.jong + ch);
      if (merged && JONGSEONG_MAP.has(merged)) {
        const s = syllableFrom(last.cho, last.jung, merged);
        if (s) {
          parts[parts.length - 1] = { ...s, span: last.span + 1 };
          continue;
        }
      }
    }

    if (CHOSEONG_MAP.has(ch)) {
      if (last && last.kind === "lone" && last.ch === ch && CHO_MERGE.has(ch)) {
        parts[parts.length - 1] = {
          kind: "lone",
          ch: CHO_MERGE.get(ch)!,
          span: last.span + 1,
        };
      } else {
        parts.push({ kind: "lone", ch, span: 1 });
      }
      continue;
    }

    if (JUNGSEONG_MAP.has(ch)) {
      if (last && last.kind === "lone" && CHOSEONG_MAP.has(last.ch)) {
        const s = syllableFrom(last.ch, ch, "");
        if (s) {
          parts[parts.length - 1] = { ...s, span: last.span + 1 };
          continue;
        }
      }
      if (last && last.kind === "syllable" && !last.jong) {
        const merged = JUNG_MERGE.get(last.jung + ch);
        if (merged) {
          const s = syllableFrom(last.cho, merged, "");
          if (s) {
            parts[parts.length - 1] = { ...s, span: last.span + 1 };
            continue;
          }
        }
      }
      if (last && last.kind === "syllable" && last.jong) {
        // 가 + ㄴ + ㅏ: the jong detaches and starts the next syllable.
        const detach = JONG_SPLIT.get(last.jong);
        if (detach) {
          const [keep, nextCho] = detach;
          const prev = syllableFrom(last.cho, last.jung, keep);
          const nextS = syllableFrom(nextCho, ch, "");
          if (prev && nextS) {
            parts[parts.length - 1] = { ...prev, span: last.span };
            parts.push({ ...nextS, span: 1 });
            continue;
          }
        }
      }
      parts.push({ kind: "lone", ch, span: 1 });
      continue;
    }

    // Already-composed syllable (or non-Jamo Hangul) — keep as its own unit.
    const decomp = decomposeChar(ch);
    if (decomp && decomp.length >= 2) {
      const s = syllableFrom(decomp[0], decomp[1], decomp[2] ?? "");
      if (s) {
        parts.push({ ...s, span: 1 });
        continue;
      }
    }
    parts.push({ kind: "lone", ch, span: 1 });
  }

  return parts;
}

function composeSmart(raw: string): string {
  return buildParts(raw)
    .map((p) =>
      p.kind === "syllable"
        ? String.fromCodePoint(
            HANGUL_SYLLABLE_BASE +
              (CHOSEONG_MAP.get(p.cho)! * JUNGSEONG_COUNT +
                JUNGSEONG_MAP.get(p.jung)!) *
                28 +
              (p.jong ? JONGSEONG_MAP.get(p.jong)! : 0)
          )
        : p.ch
    )
    .join("");
}

/**
 * A composed result is valid while the last unit may still be incomplete:
 * a lone jongseong anywhere is malformed, and a lone choseong is only
 * allowed at the very end (still waiting for its vowel).
 */
function isValidComposed(composed: string): boolean {
  const chars = [...composed];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (JONGSEONG_MAP.has(ch) && !CHOSEONG_MAP.has(ch)) return false;
    if (CHOSEONG_MAP.has(ch) && !JUNGSEONG_MAP.has(ch)) {
      if (i !== chars.length - 1) return false;
    }
  }
  return true;
}

/**
 * Split text into alternating Hangul and non-Hangul runs, preserving order.
 */
function splitRuns(text: string): Array<{ hangul: boolean; text: string }> {
  const runs: Array<{ hangul: boolean; text: string }> = [];
  for (const ch of text) {
    const hangul = isHangulChar(ch);
    const last = runs.at(-1);
    if (last && last.hangul === hangul) {
      last.text += ch;
    } else {
      runs.push({ hangul, text: ch });
    }
  }
  return runs;
}

export interface HangulFeedResult {
  /** Number of characters to erase with backspace before sending. */
  erase: number;
  /** Text to send after the erasures. */
  send: string;
}

/**
 * Streaming composer state: accumulates the raw IME stream of the current
 * Hangul word, recomposes it, and reports the minimal correction against
 * what was already sent. Since corrections go out immediately there is no
 * buffered text to flush — any keydown, paste, or non-Hangul input simply
 * calls breakWord().
 */
export class HangulComposer {
  private raw = "";
  private emitted = "";
  private tailFromJamo = false;
  private pendingTenseOnset = false;

  reset(): void {
    this.raw = "";
    this.emitted = "";
    this.tailFromJamo = false;
    this.pendingTenseOnset = false;
  }

  breakWord(): void {
    this.reset();
  }

  /** True while a Hangul word is being accumulated (raw jamo present). */
  hasActiveWord(): boolean {
    return this.raw.length > 0;
  }

  /**
   * Drop the current word and report erasing whatever was already sent
   * (the IME canceled or reverted the composition).
   */
  flushReset(): HangulFeedResult {
    const result = { erase: [...this.emitted].length, send: "" };
    this.reset();
    return result;
  }

  feed(text: string): HangulFeedResult {
    let erase = 0;
    let send = "";

    for (const run of splitRuns(text)) {
      if (!run.hangul) {
        this.breakWord();
        send += run.text;
        continue;
      }

      const previousTailFromJamo = this.tailFromJamo;
      const includesJamoDelta = [...run.text].some(
        (ch) => decomposeChar(ch)?.length === 1
      );
      const appendedRaw = this.raw + run.text;
      let candidateRaw = appendedRaw;
      let replacedTail = false;
      const parts = buildParts(this.raw);
      const lastPart = parts.at(-1);
      const continuesTenseOnset =
        this.pendingTenseOnset &&
        run.text.length === 1 &&
        JUNGSEONG_MAP.has(run.text) &&
        lastPart?.kind === "syllable" &&
        (lastPart.jong === "ㄲ" || lastPart.jong === "ㅆ");
      const startsTenseOnset =
        !this.pendingTenseOnset &&
        (run.text === "ㄲ" || run.text === "ㅆ") &&
        lastPart?.kind === "syllable" &&
        !lastPart.jong;

      if (continuesTenseOnset && lastPart?.kind === "syllable") {
        candidateRaw =
          this.raw.slice(0, this.raw.length - lastPart.span) +
          composeSmart(lastPart.cho + lastPart.jung) +
          composeSmart(lastPart.jong + run.text);
      } else if (!startsTenseOnset && lastPart && run.text.length === 1) {
        const lastParts =
          lastPart.kind === "syllable"
            ? [
                lastPart.cho,
                lastPart.jung,
                ...(lastPart.jong ? [lastPart.jong] : []),
              ]
            : decomposeChar(lastPart.ch);
        const runParts = decomposeChar(run.text);
        if (lastParts && runParts) {
          const isGrowth =
            runParts.length > lastParts.length &&
            lastParts.every((p, i) => runParts[i] === p);
          const isShrink =
            runParts.length > 1 &&
            lastParts.length > runParts.length &&
            runParts.every((p, i) => lastParts[i] === p);
          const isDerivedJamo =
            lastParts.length === 1 &&
            runParts.length === 1 &&
            (CHO_MERGE.get(lastParts[0]) === runParts[0] ||
              JONG_MERGE.get(lastParts[0]) === runParts[0]);
          const isEqualResend =
            previousTailFromJamo &&
            runParts.length > 1 &&
            runParts.length === lastParts.length &&
            lastParts
              .slice(0, -1)
              .every((p, i) => runParts[i] === p);
          if (isGrowth || isShrink || isDerivedJamo || isEqualResend) {
            candidateRaw =
              this.raw.slice(0, this.raw.length - lastPart.span) + run.text;
            replacedTail = true;
          }
        }
      }

      let composed = continuesTenseOnset
        ? candidateRaw
        : composeSmart(candidateRaw);
      if (!isValidComposed(composed) && replacedTail) {
        candidateRaw = appendedRaw;
        composed = composeSmart(candidateRaw);
        replacedTail = false;
      }

      const emittedChars = [...this.emitted];
      const composedChars = [...composed];
      let common = 0;
      while (
        common < emittedChars.length &&
        common < composedChars.length &&
        emittedChars[common] === composedChars[common]
      ) {
        common++;
      }
      erase += emittedChars.length - common;
      send += composedChars.slice(common).join("");

      // Canonicalize after every delivery. Replaying the full raw keystroke
      // history loses syllable boundaries after a jong splits onto a vowel.
      this.raw = composed;
      this.emitted = composed;
      this.tailFromJamo =
        includesJamoDelta || (replacedTail && previousTailFromJamo);
      this.pendingTenseOnset = startsTenseOnset;
    }

    return { erase, send };
  }
}

/**
 * One-shot normalization: compose any compatibility Jamo runs into
 * syllables and NFC-normalize the rest.
 */
export function composeJamoSequence(text: string): string {
  let out = "";
  for (const run of splitRuns(text.normalize("NFC"))) {
    out += run.hangul ? composeSmart(run.text) : run.text;
  }
  return out;
}
