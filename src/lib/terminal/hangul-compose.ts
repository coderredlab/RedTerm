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

/** Direct tense Jamo that can replace an in-progress basic consonant resend. */
const TENSE_CONSONANT = new Map<string, string>([
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
]);

/**
 * How a jongseong splits when a vowel follows: [kept jong, new choseong].
 * Basic and direct tense consonants detach entirely; clusters keep their first component.
 */
const JONG_SPLIT = new Map<string, [string, string]>([
  ["ㄱ", ["", "ㄱ"]],
  ["ㄲ", ["", "ㄲ"]],
  ["ㄴ", ["", "ㄴ"]],
  ["ㄵ", ["ㄴ", "ㅈ"]],
  ["ㄶ", ["ㄴ", "ㅎ"]],
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
  ["ㅆ", ["", "ㅆ"]],
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
 * merging keystrokes that extend the previous unit (compound vowels,
 * jongseong attach, jongseong clusters).
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
      parts.push({ kind: "lone", ch, span: 1 });
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
  private pendingOnsetJamo: string | null = null;

  reset(): void {
    this.raw = "";
    this.emitted = "";
    this.tailFromJamo = false;
    this.pendingOnsetJamo = null;
  }
  breakWord(): void {
    this.reset();
  }

  /** True while a Hangul word is being accumulated (raw jamo present). */
  hasActiveWord(): boolean {
    return this.raw.length > 0;
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
      const runChars = [...run.text];
      const includesJamoDelta = runChars.some(
        (ch) => decomposeChar(ch)?.length === 1
      );
      const appendedRaw = this.raw + run.text;
      let candidateRaw = appendedRaw;
      let replacedTail = false;
      const parts = buildParts(this.raw);
      const lastPart = parts.at(-1);
      const firstRunParts = runChars[0] ? decomposeChar(runChars[0]) : null;
      const pendingJongSplit =
        lastPart?.kind === "syllable" && lastPart.jong
          ? JONG_SPLIT.get(lastPart.jong)
          : undefined;
      const runStartsSyllable =
        (firstRunParts?.length ?? 0) > 1 ||
        (runChars.length > 1 &&
          firstRunParts?.length === 1 &&
          CHOSEONG_MAP.has(firstRunParts[0]) &&
          JUNGSEONG_MAP.has(runChars[1]));
      const continuesPendingOnset =
        runStartsSyllable &&
        this.pendingOnsetJamo !== null &&
        firstRunParts?.[0] === this.pendingOnsetJamo &&
        pendingJongSplit?.[1] === this.pendingOnsetJamo;

      if (continuesPendingOnset && lastPart?.kind === "syllable" && pendingJongSplit) {
        candidateRaw =
          this.raw.slice(0, this.raw.length - lastPart.span) +
          composeSmart(lastPart.cho + lastPart.jung + pendingJongSplit[0]) +
          run.text;
        replacedTail = true;
      } else if (lastPart && runChars.length === 1) {
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
            lastParts.every((part, index) => runParts[index] === part);
          const isShrink =
            previousTailFromJamo &&
            runParts.length > 1 &&
            lastParts.length > runParts.length &&
            runParts.every((part, index) => lastParts[index] === part);
          const isDerivedJamo =
            lastParts.length === 1 &&
            runParts.length === 1 &&
            TENSE_CONSONANT.get(lastParts[0]) === runParts[0];
          const isEqualResend =
            previousTailFromJamo &&
            runParts.length > 1 &&
            runParts.length === lastParts.length &&
            lastParts
              .slice(0, -1)
              .every((part, index) => runParts[index] === part);
          if (isGrowth || isShrink || isDerivedJamo || isEqualResend) {
            candidateRaw =
              this.raw.slice(0, this.raw.length - lastPart.span) + run.text;
            replacedTail = true;
          }
        }
      }

      let composed = composeSmart(candidateRaw);
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

      const composedLastPart = buildParts(composed).at(-1);
      const latestJamo =
        runChars.length === 1 &&
        decomposeChar(runChars[0])?.length === 1 &&
        CHOSEONG_MAP.has(runChars[0])
          ? runChars[0]
          : null;
      const latestJongSplit =
        composedLastPart?.kind === "syllable" && composedLastPart.jong
          ? JONG_SPLIT.get(composedLastPart.jong)
          : undefined;
      this.pendingOnsetJamo =
        latestJamo && latestJongSplit?.[1] === latestJamo
          ? latestJamo
          : null;
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
