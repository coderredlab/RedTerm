import { composeJamoSequence } from "./hangul-compose";

export interface AndroidTextChange {
  erase: number;
  text: string;
}

const NO_REMOTE_EDIT: AndroidTextChange = { erase: 0, text: "" };

function matchesCanceledCandidate(value: string, prefix: string, physicalTail: string): boolean {
  if (!prefix || !value.startsWith(prefix)) return false;
  const echoed = value.length - prefix.length;
  if (echoed > physicalTail.length) return false;
  for (let i = 0; i < echoed; i++) {
    if (value.charCodeAt(prefix.length + i) !== physicalTail.charCodeAt(i)) return false;
  }
  return true;
}

export function isCanceledAndroidCompositionValue(
  value: string, editor: string, marked: string, full: string, reportedKeys: string
): boolean {
  const tail = reportedKeys || editor;
  return matchesCanceledCandidate(value, marked, tail) ||
    matchesCanceledCandidate(value, editor + marked, tail) ||
    matchesCanceledCandidate(value, full, tail) ||
    matchesCanceledCandidate(value, editor + full, tail);
}

// Keep the Android editor as the IME sees it. Replacing the marked "n" with
// "nv" inserts only "v"; inserting a separate "nv" after "n" inserts both.
// Clearing the textarea after each input erases this distinction.
export class AndroidTextDelta {
  private value = "";
  private composing = false;
  private deferred = false;
  private startValue = "";
  private domValue = "";
  private markedStart = -1;
  private markedLength = 0;
  private selectedRange = false;
  private pending: { editor: string; start: number; sourceLength: number; finalLength: number; fullText: string; echoSuffix: string; appendAt: number; finalEditor: string; physicalKeys: string } | null = null;
  private recentEcho: { fullText: string; echoSuffix: string } | null = null;
  private rejectedEcho: { fullText: string; echoSuffix: string; finalEditor: string; physicalKey: string } | null = null;
  private independentKey = false;
  private compositionPhysicalKeys = "";
  private hasDeferredPhysicalKey = false;

  get editorValue(): string {
    return this.value;
  }

  get hasPendingCommit(): boolean {
    return this.pending !== null;
  }
  get hasProvisionalEdit(): boolean {
    return this.composing && this.domValue !== this.value;
  }
  get markedCompositionText(): string {
    if (!this.composing) return "";
    if (this.markedStart >= 0) {
      return this.domValue.slice(this.markedStart, this.markedStart + this.markedLength);
    }
    // Some IMEs mark their native edit as composing but send insertText
    // instead of insertCompositionText. Recover the provisional edit from
    // the editor at compositionstart rather than treating its prefix as new.
    const old = this.startValue;
    const next = this.domValue;
    let start = 0;
    while (start < old.length && start < next.length && old.codePointAt(start) === next.codePointAt(start)) {
      start += old.codePointAt(start)! > 0xffff ? 2 : 1;
    }
    let oldEnd = old.length;
    let nextEnd = next.length;
    while (oldEnd > start && nextEnd > start) {
      const oldWidth = old.charCodeAt(oldEnd - 1) >= 0xdc00 && old.charCodeAt(oldEnd - 1) <= 0xdfff ? 2 : 1;
      const nextWidth = next.charCodeAt(nextEnd - 1) >= 0xdc00 && next.charCodeAt(nextEnd - 1) <= 0xdfff ? 2 : 1;
      if (oldWidth !== nextWidth || old.codePointAt(oldEnd - oldWidth) !== next.codePointAt(nextEnd - nextWidth)) break;
      oldEnd -= oldWidth;
      nextEnd -= nextWidth;
    }
    return next.slice(start, nextEnd);
  }

  noteIndependentKey(key = ""): void {
    if (this.composing || this.pending || this.recentEcho || this.rejectedEcho) this.independentKey = true;
    if (this.rejectedEcho && key) this.rejectedEcho.physicalKey = key;
    if (this.composing && key) this.compositionPhysicalKeys += key;
  }
  noteDeferredPhysicalKey(key: string): void {
    if (!this.composing) return;
    this.noteIndependentKey(key);
    this.hasDeferredPhysicalKey = true;
  }

  compositionStart(selectionStart = -1, selectionEnd = -1): void {
    this.composing = true;
    this.deferred = false;
    this.startValue = this.value;
    this.domValue = this.value;
    this.markedStart = selectionStart >= 0 && selectionEnd > selectionStart && selectionEnd <= this.value.length ? selectionStart : -1;
    this.markedLength = this.markedStart >= 0 ? selectionEnd - selectionStart : 0;
    this.selectedRange = this.markedStart >= 0;
    this.pending = null;
    this.recentEcho = null;
    this.rejectedEcho = null;
    this.independentKey = false;
    this.compositionPhysicalKeys = "";
    this.hasDeferredPhysicalKey = false;
  }
  deferComposingText(): void {
    if (this.composing) this.deferred = true;
  }

  compositionUpdate(text: string, value: string): void {
    if (!text && value === this.domValue) return;
    let start = 0;
    while (start < this.domValue.length && start < value.length && this.domValue[start] === value[start]) start++;
    let oldEnd = this.domValue.length;
    let newEnd = value.length;
    while (oldEnd > start && newEnd > start && this.domValue[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    if (value !== this.domValue) {
      if (this.selectedRange) {
        const end = this.markedStart + this.markedLength;
        const before = this.domValue.slice(0, this.markedStart);
        const after = this.domValue.slice(end);
        const retainedSides = !text && value.length >= before.length + after.length &&
          value.startsWith(before) && value.endsWith(after);
        const match = text ? value.lastIndexOf(text, this.markedStart) : -1;
        if (retainedSides) {
          this.markedLength = value.length - before.length - after.length;
        } else if (match >= 0 && match <= this.markedStart && match + text.length >= end) {
          this.markedStart = match;
          this.markedLength = text.length;
        } else if (start <= end && oldEnd >= this.markedStart) {
          this.markedStart = Math.min(this.markedStart, start);
          this.markedLength = Math.max(0, end - this.markedStart + newEnd - oldEnd);
        } else if (oldEnd <= this.markedStart) {
          this.markedStart += newEnd - oldEnd;
        }
      } else if (!text) {
        if (this.markedStart >= 0 && start <= this.markedStart + this.markedLength && oldEnd >= this.markedStart) {
          this.markedLength = Math.max(0, this.markedLength + newEnd - oldEnd);
        } else {
          this.markedStart = start;
          this.markedLength = newEnd - start;
        }
      } else {
        for (let match = value.lastIndexOf(text, start); match >= 0;) {
          if (match <= start && match + text.length >= newEnd) {
            this.markedStart = match;
            this.markedLength = text.length;
            break;
          }
          if (match === 0) break;
          match = value.lastIndexOf(text, match - 1);
        }
      }
      this.domValue = value;
    } else if (text && this.markedStart < 0) {
      const match = value.indexOf(text);
      if (match >= 0 && value.indexOf(text, match + 1) < 0) {
        this.markedStart = match;
        this.markedLength = text.length;
      }
    }
  }

  input(value: string, inputType: string, data = ""): AndroidTextChange | null {
    if (this.rejectedEcho && !this.composing) {
      const echo = this.rejectedEcho;
      // A physical key can start before Android delivers the previous IME's
      // explicit echo. Only a matching physical glyph claims this candidate.
      const physicalCandidate = !!data && this.independentKey &&
        (!echo.physicalKey || echo.physicalKey === data);
      if (!physicalCandidate && (inputType === "insertCompositionText" || inputType === "insertFromComposition") &&
        ((data && (data === echo.fullText || data === echo.echoSuffix) && value === this.value + data) ||
          (!data && value === echo.finalEditor))) {
        this.rejectedEcho = null;
        return null;
      }
    }
    if (this.pending && !this.composing) return this.reconcilePending(value, inputType, data);
    if (this.recentEcho && !this.composing) {
      const echo = this.recentEcho;
      this.recentEcho = null;
      if ((inputType === "" || inputType === "insertFromComposition") && !this.independentKey && data &&
        (data === echo.fullText || data === echo.echoSuffix) && value === this.value + data) {
        return null;
      }
      this.independentKey = false;
    }
    if (this.composing) {
      if (inputType === "insertCompositionText") this.compositionUpdate(data, value);
      else this.domValue = value;
      if (this.deferred || (inputType !== "insertCompositionText" && inputType !== "deleteContentBackward")) {
        this.deferred = true;
        return null;
      }
      const change = this.diff(value);
      if (change && /[^\x20-\x7e]/.test(change.text)) {
        this.deferred = true;
        return null;
      }
      this.value = value;
      return change;
    }
    const change = this.apply(value);
    if (change) this.independentKey = false;
    return change;
  }

  compositionEnd(value: string, committedText?: string): AndroidTextChange | null {
    this.composing = false;
    this.deferred = false;
    const physicalKeys = this.compositionPhysicalKeys;
    const deferredPhysicalKey = this.hasDeferredPhysicalKey;
    this.hasDeferredPhysicalKey = false;
    this.compositionPhysicalKeys = "";
    this.independentKey = false;
    const editor = value;
    let start = this.markedStart;
    let sourceLength = start >= 0 ? this.markedLength : 0;
    let survivingPhysical = 0;
    // The last native input may describe only the last physical key. A final
    // candidate can replace the earlier provisional word and cancel some or
    // all of those keys before compositionend updates the textarea. In this
    // append-only case the native editor before the commit gives us the whole
    // marked span; use the committed word, not the last key's marked range.
    const finalNativeTail = committedText && !this.selectedRange && physicalKeys &&
      editor.startsWith(this.startValue + committedText)
      ? editor.slice(this.startValue.length + committedText.length) : "";
    const finalNativePhysical = !!finalNativeTail && physicalKeys.startsWith(finalNativeTail);
    // A late native candidate update may already have replaced the whole
    // marked word, even if the previous mark still points past its new end.
    const alreadyFinalWord = committedText && !this.selectedRange && physicalKeys &&
      editor === this.startValue + committedText;
    const wholeProvisionalWord = committedText && !this.selectedRange && physicalKeys &&
      this.domValue.startsWith(this.startValue) && this.domValue.endsWith(physicalKeys) &&
      this.domValue.length > this.startValue.length + physicalKeys.length;
    if (wholeProvisionalWord) {
      start = this.startValue.length;
      sourceLength = this.domValue.length - start;
      // A candidate-only payload cannot cancel a physical prefix already
      // present after the completed candidate in the native textarea.
      value = finalNativePhysical ? editor : this.startValue + committedText;
    }
    // A native cancellation may retain a physical prefix (the later key was
    // canceled) or suffix (an earlier key was replaced). Only trust a final
    // editor made of the original text plus those independently sent keys;
    // never keep an unfinished CJK candidate on an empty compositionend.
    if (committedText === "") {
      if (editor.startsWith(this.startValue)) {
        const remainder = editor.slice(this.startValue.length);
        if (remainder && (physicalKeys.startsWith(remainder) || physicalKeys.endsWith(remainder))) {
          survivingPhysical = remainder.length;
        }
      }
      value = survivingPhysical ? editor : this.startValue;
    } else if (!wholeProvisionalWord && !finalNativePhysical && !alreadyFinalWord && committedText && start >= 0 && value.slice(start, start + sourceLength) !== committedText) {
      // The latest input.data can identify only the trailing physical key.
      // If compositionend.data includes the whole candidate and that key,
      // replace the candidate from the start boundary instead of inserting
      // the full word after an older, still provisional CJK prefix.
      let physicalSuffix = 0;
      while (physicalSuffix < physicalKeys.length && physicalSuffix < committedText.length &&
        physicalSuffix < value.length &&
        physicalKeys.charCodeAt(physicalKeys.length - 1 - physicalSuffix) === value.charCodeAt(value.length - 1 - physicalSuffix) &&
        committedText.charCodeAt(committedText.length - 1 - physicalSuffix) === value.charCodeAt(value.length - 1 - physicalSuffix)) {
        physicalSuffix++;
      }
      const candidateStart = this.startValue.length;
      const candidateEnd = value.length - physicalSuffix;
      if (!this.selectedRange && physicalSuffix && value.startsWith(this.startValue) &&
        candidateEnd > candidateStart && start >= candidateStart && start <= candidateEnd) {
        start = candidateStart;
        sourceLength = value.length - start;
        value = value.slice(0, start) + committedText;
      } else {
        // input.data may contain only the last edit while compositionend.data
        // describes the entire marked word already present in the editor.
        const fullStart = this.selectedRange ? -1 : value.lastIndexOf(committedText, start);
        if (fullStart >= 0 && fullStart + committedText.length >= start + sourceLength) {
          start = fullStart;
          sourceLength = committedText.length;
        } else if (this.selectedRange) {
          value = value.slice(0, start) + committedText + value.slice(start + sourceLength);
        } else {
          // A shorter final candidate can be the prefix of the provisional
          // word, rather than overlap the last incremental input.data.
          const prior = value.slice(0, start);
          const priorStart = prior.lastIndexOf(committedText);
          if (priorStart >= 0 && priorStart + committedText.length < prior.length) {
            sourceLength += start - priorStart;
            start = priorStart;
          } else {
            for (let overlap = Math.min(start, committedText.length); overlap > 0; overlap--) {
              if (value.slice(start - overlap, start) !== committedText.slice(0, overlap)) continue;
              if (start - overlap > 0 && value.charCodeAt(start - overlap) >= 0xdc00 && value.charCodeAt(start - overlap) <= 0xdfff) continue;
              if (overlap < committedText.length && committedText.charCodeAt(overlap) >= 0xdc00 && committedText.charCodeAt(overlap) <= 0xdfff) continue;
              start -= overlap;
              sourceLength += overlap;
              break;
            }
          }
          value = value.slice(0, start) + committedText + value.slice(start + sourceLength);
        }
      }
    } else if (committedText && start < 0 && value === this.startValue && !value.endsWith(committedText)) {
      value += committedText;
    }
    if (value !== editor) {
      let spanStart = start >= 0 ? start : this.startValue.length;
      let nativeLength = start >= 0 ? sourceLength : committedText === "" ? Math.max(0, editor.length - this.startValue.length) : 0;
      let finalLength = Math.max(0, value.length - editor.length + nativeLength);
      while (nativeLength && finalLength && editor.codePointAt(spanStart) === value.codePointAt(spanStart)) {
        const width = editor.codePointAt(spanStart)! > 0xffff ? 2 : 1;
        spanStart += width;
        nativeLength -= width;
        finalLength -= width;
      }
      while (nativeLength && finalLength) {
        const nativeEnd = spanStart + nativeLength;
        const finalEnd = spanStart + finalLength;
        const nativeWidth = editor.charCodeAt(nativeEnd - 1) >= 0xdc00 && editor.charCodeAt(nativeEnd - 1) <= 0xdfff ? 2 : 1;
        const finalWidth = value.charCodeAt(finalEnd - 1) >= 0xdc00 && value.charCodeAt(finalEnd - 1) <= 0xdfff ? 2 : 1;
        if (nativeWidth !== finalWidth || editor.codePointAt(nativeEnd - nativeWidth) !== value.codePointAt(finalEnd - finalWidth)) break;
        nativeLength -= nativeWidth;
        finalLength -= finalWidth;
      }
      this.pending = { editor, start: spanStart, sourceLength: nativeLength, finalLength, fullText: committedText ?? "", echoSuffix: value.slice(spanStart, spanStart + finalLength), appendAt: start + sourceLength, finalEditor: value, physicalKeys };
    } else {
      this.pending = null;
    }
    this.markedStart = -1;
    this.markedLength = 0;
    this.selectedRange = false;
    const change = this.apply(value);
    // On cancellation, omit only surviving keys already sent at keydown.
    return !deferredPhysicalKey && committedText === "" && survivingPhysical && change?.erase === 0 &&
      change.text === value.slice(-survivingPhysical) ? null : change;
  }

  compact(): string | null {
    if (this.composing || this.pending || this.value.length <= 512) return null;
    let start = this.value.length - 128;
    if (start > 0 && /[\uDC00-\uDFFF]/.test(this.value[start])) start++;
    this.value = this.value.slice(start);
    return this.value;
  }

  restoreEditor(value: string): void {
    this.reset();
    this.value = value;
    this.domValue = value;
  }

  replaceSelectedPending(
    value: string, beforeValue: string, start: number, end: number, data: string
  ): AndroidTextChange | null {
    const pending = this.pending;
    if (!pending || this.composing || !data || beforeValue !== pending.editor ||
      start < 0 || end !== beforeValue.length ||
      pending.start + pending.sourceLength !== beforeValue.length ||
      pending.start + pending.finalLength !== this.value.length ||
      this.value.slice(0, Math.min(start, pending.start)) !== beforeValue.slice(0, Math.min(start, pending.start)) ||
      value !== beforeValue.slice(0, start) + data) return null;
    // beforeinput proves an independent selected-tail replacement. The DOM
    // may still show the old provisional word, so an unchanged DOM string is
    // not an unchanged remote edit. Keep pending only to discard its late echo.
    let remoteStart = start;
    if (start > pending.start) {
      // An interior selection can only map to the confirmed text if both
      // pending spans align by Unicode scalar and UTF-16 prefix boundary.
      let nativeScalars = 0;
      for (let i = pending.start; i < beforeValue.length; i += beforeValue.codePointAt(i)! > 0xffff ? 2 : 1) nativeScalars++;
      let finalScalars = 0;
      for (let i = pending.start; i < this.value.length; i += this.value.codePointAt(i)! > 0xffff ? 2 : 1) finalScalars++;
      let nativeStart = pending.start;
      remoteStart = pending.start;
      while (nativeStart < start && remoteStart < this.value.length) {
        nativeStart += beforeValue.codePointAt(nativeStart)! > 0xffff ? 2 : 1;
        remoteStart += this.value.codePointAt(remoteStart)! > 0xffff ? 2 : 1;
      }
      if (nativeScalars !== finalScalars || nativeStart !== start || remoteStart !== start) {
        // An ambiguous partial edit cannot be represented as a tail DEL.
        this.restoreEditor(this.value);
        // The restored editor can receive independent soft edits before the
        // old native composition candidate arrives. Retain only its identity.
        this.rejectedEcho = { fullText: pending.fullText, echoSuffix: pending.echoSuffix, finalEditor: pending.finalEditor, physicalKey: "" };
        return NO_REMOTE_EDIT;
      }
    }
    let erase = 0;
    for (let i = remoteStart; i < this.value.length; i += this.value.codePointAt(i)! > 0xffff ? 2 : 1) erase++;
    this.value = this.value.slice(0, remoteStart) + data;
    this.domValue = value;
    pending.editor = value;
    pending.start = start;
    pending.sourceLength = data.length;
    pending.finalLength = data.length;
    pending.appendAt = value.length;
    this.independentKey = false;
    return { erase, text: data };
  }

  reset(): void {
    this.value = "";
    this.composing = false;
    this.deferred = false;
    this.startValue = "";
    this.domValue = "";
    this.markedStart = -1;
    this.markedLength = 0;
    this.selectedRange = false;
    this.pending = null;
    this.recentEcho = null;
    this.rejectedEcho = null;
    this.independentKey = false;
    this.compositionPhysicalKeys = "";
    this.hasDeferredPhysicalKey = false;
  }

  private reconcilePending(value: string, inputType: string, data: string): AndroidTextChange | null {
    const pending = this.pending!;
    // A physical Backspace always erases one committed terminal scalar, even
    // if the native editor removes a provisional character or repeated suffix.
    if (inputType === "deleteContentBackward") {
      const last = pending.editor.charCodeAt(pending.editor.length - 1);
      const nativeStart = pending.editor.length - (last >= 0xdc00 && last <= 0xdfff ? 2 : 1);
      if (value === pending.editor || value === pending.editor.slice(0, nativeStart)) {
        const finalLast = this.value.charCodeAt(this.value.length - 1);
        const finalStart = this.value.length ? this.value.length - (finalLast >= 0xdc00 && finalLast <= 0xdfff ? 2 : 1) : 0;
        const change = this.apply(this.value.slice(0, finalStart)) ?? { erase: 1, text: "" };
        if (value.length < pending.editor.length && nativeStart < pending.appendAt) {
          pending.appendAt -= pending.editor.length - value.length;
        }
        pending.editor = value;
        pending.start = Math.min(pending.start, value.length, this.value.length);
        pending.appendAt = Math.max(pending.start, Math.min(pending.appendAt, value.length));
        pending.sourceLength = pending.appendAt - pending.start;
        pending.finalLength = Math.max(0, this.value.length - pending.start - (value.length - pending.appendAt));
        return change;
      }
    }
    if (value === pending.editor) return null;
    // insertFromComposition identifies the old IME transaction even when
    // Chromium omits its data. A selected soft edit may have changed the
    // remote text while its old final candidate is still arriving natively.
    if ((inputType === "insertFromComposition" || inputType === "insertCompositionText") &&
      !data && value === pending.finalEditor) {
      this.pending = null;
      return null;
    }
    // Chromium normalizes legacy insertFromComposition to an empty inputType.
    // The native IME can append either the changed suffix or its full word.
    const nativeEcho = (inputType === "insertFromComposition" ||
      ((inputType === "" || inputType === "insertCompositionText") && !this.independentKey)) && data && (
      (data === pending.echoSuffix &&
        value === pending.editor.slice(0, pending.start + pending.sourceLength) + data + pending.editor.slice(pending.start + pending.sourceLength)) ||
      (data === pending.fullText && (
        value === pending.editor.slice(0, pending.appendAt) + data + pending.editor.slice(pending.appendAt) ||
        value === pending.finalEditor
      ))
    );
    if ((inputType === "insertFromComposition" || inputType === "insertCompositionText" ||
      inputType === "") && !this.independentKey && data &&
      (data === pending.fullText || data === pending.echoSuffix)) {
      // Native cleanup can remove the whole provisional span before inserting
      // the candidate and any following text. That insertion is the final
      // editor, not a second candidate to splice after the one already sent.
      const trailing = value.startsWith(pending.finalEditor) ? value.slice(pending.finalEditor.length) : "";
      const cleaned = pending.editor.length === pending.start;
      if (trailing && (cleaned || (pending.editor.endsWith(trailing) &&
        pending.finalEditor.startsWith(pending.fullText, pending.start) &&
        pending.physicalKeys.startsWith(
          pending.finalEditor.slice(pending.start + pending.fullText.length) + trailing
        )))) {
        this.pending = null;
        this.independentKey = false;
        return this.apply(value);
      }
    }
    if ((value === this.value && (inputType !== "insertText" || !data) && !this.independentKey) || nativeEcho) {
      this.pending = null;
      return inputType === "deleteContentBackward" ? NO_REMOTE_EDIT : null;
    }
    // Chromium may report a composition cleanup with an empty inputType.
    // Recognize removal of the pending marked span by the native editor,
    // rather than treating the subsequent final insert as a second commit.
    const removedMarked = inputType === "" && !data && pending.sourceLength > 0 &&
      value.length < pending.editor.length &&
      value.startsWith(pending.editor.slice(0, pending.start)) &&
      value.endsWith(pending.editor.slice(pending.start + pending.sourceLength));
    if (inputType === "deleteCompositionText" || removedMarked) {
      pending.sourceLength = Math.max(0, pending.sourceLength - (pending.editor.length - value.length));
      pending.editor = value;
      return null;
    }
    let start = 0;
    while (start < pending.editor.length && start < value.length) {
      const point = pending.editor.codePointAt(start);
      if (point !== value.codePointAt(start)) break;
      start += point! > 0xffff ? 2 : 1;
    }
    let oldEnd = pending.editor.length;
    let newEnd = value.length;
    while (oldEnd > start && newEnd > start) {
      const oldPoint = pending.editor.codePointAt(oldEnd - (pending.editor.charCodeAt(oldEnd - 1) >= 0xdc00 && pending.editor.charCodeAt(oldEnd - 1) <= 0xdfff ? 2 : 1));
      const newPoint = value.codePointAt(newEnd - (value.charCodeAt(newEnd - 1) >= 0xdc00 && value.charCodeAt(newEnd - 1) <= 0xdfff ? 2 : 1));
      if (oldPoint !== newPoint) break;
      const width = oldPoint! > 0xffff ? 2 : 1;
      oldEnd -= width;
      newEnd -= width;
    }
    const map = (index: number, end: boolean): number => {
      if (index < pending.start) return index;
      if (index > pending.start + pending.sourceLength) return index + pending.finalLength - pending.sourceLength;
      if (pending.sourceLength === 0) return pending.start + pending.finalLength;
      if (index === pending.start) return index;
      if (index === pending.start + pending.sourceLength) return pending.start + pending.finalLength;
      return end ? pending.start + pending.finalLength : pending.start;
    };
    const resolved = this.value.slice(0, map(start, false)) + value.slice(start, newEnd) + this.value.slice(map(oldEnd, true));
    this.pending = null;
    // An unrelated text insert resolves the pending editor but is not another
    // native echo of the old candidate. Never arm content-based suppression
    // across that edit: a later soft key may have the same candidate text.
    if (!this.independentKey && (inputType === "" || inputType === "insertFromComposition" ||
      inputType === "insertCompositionText") && data &&
      (data === pending.fullText || data === pending.echoSuffix)) {
      this.recentEcho = { fullText: pending.fullText, echoSuffix: pending.echoSuffix };
    }
    this.independentKey = false;
    return this.apply(resolved) ?? (inputType === "deleteContentBackward" ? NO_REMOTE_EDIT : null);
  }

  private apply(value: string): AndroidTextChange | null {
    const change = this.diff(value);
    this.value = value;
    return change;
  }

  private diff(value: string): AndroidTextChange | null {
    if (value === this.value) return null;
    let prefix = 0;
    while (prefix < this.value.length && prefix < value.length) {
      const codePoint = this.value.codePointAt(prefix);
      if (codePoint !== value.codePointAt(prefix)) break;
      prefix += codePoint! > 0xffff ? 2 : 1;
    }
    let erase = 0;
    for (let index = prefix; index < this.value.length; erase++) {
      index += this.value.codePointAt(index)! > 0xffff ? 2 : 1;
    }
    return { erase, text: value.slice(prefix) };
  }
}

function ambiguousDeletion(old: string, next: string, prefix: number): boolean {
  if (old.length <= next.length) return false;
  let suffix = 0;
  while (suffix < next.length && old.charCodeAt(old.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) {
    suffix++;
  }
  return prefix + suffix > next.length;
}

// The Android editor can mix reported legacy text, Kitty physical presses,
// and soft-keyboard text never sent under physical-only mode. Retain remote
// origin by UTF-16 offset so a native-only Backspace cannot delete unrelated
// terminal text. The editor is normally compacted after 512 code units.
type AndroidPhysicalPress = { key: string; observed: number; unobserved: number };

export class AndroidRemoteTextOrigins {
  private editor = "";
  private origins = new Uint8Array(512);
  private pendingKey: string | null = null;
  private pressedKeys = new Map<string, AndroidPhysicalPress[]>();
  private pressedCodes = new Map<string, AndroidPhysicalPress[][]>();
  private composition: { editor: string; origins: Uint8Array; selectionStart: number; selectionEnd: number } | null = null;
  private composing = false;
  private compositionKeys = "";
  private compositionStartEditor = "";

  get editorValue(): string {
    return this.editor;
  }

  hasReportedTextAfter(index: number): boolean {
    for (let i = index; i < this.editor.length; i++) if (this.origins[i]) return true;
    return false;
  }

  hasReportedSuffixAfterEdit(next: string): boolean {
    const old = this.editor;
    let prefix = 0;
    while (prefix < old.length && prefix < next.length && old.codePointAt(prefix) === next.codePointAt(prefix)) {
      prefix += old.codePointAt(prefix)! > 0xffff ? 2 : 1;
    }
    let oldEnd = old.length;
    let newEnd = next.length;
    while (oldEnd > prefix && newEnd > prefix) {
      const oldWidth = old.charCodeAt(oldEnd - 1) >= 0xdc00 && old.charCodeAt(oldEnd - 1) <= 0xdfff ? 2 : 1;
      const newWidth = next.charCodeAt(newEnd - 1) >= 0xdc00 && next.charCodeAt(newEnd - 1) <= 0xdfff ? 2 : 1;
      if (oldWidth !== newWidth || old.codePointAt(oldEnd - oldWidth) !== next.codePointAt(newEnd - newWidth)) break;
      oldEnd -= oldWidth;
      newEnd -= newWidth;
    }
    for (let i = oldEnd; i < old.length; i++) if (this.origins[i]) return true;
    return false;
  }

  startComposition(selectionStart = -1, selectionEnd = -1): void {
    this.composing = true;
    this.compositionKeys = "";
    this.compositionStartEditor = this.editor;
    // Provisional IME replacements may temporarily hide a previously reported
    // physical key. Only allocate a checkpoint if there is ownership to lose.
    this.composition = null;
    for (let i = 0; i < this.editor.length; i++) {
      if (!this.origins[i]) continue;
      this.composition = {
        editor: this.editor, origins: this.origins.slice(0, this.editor.length),
        selectionStart, selectionEnd
      };
      break;
    }
  }

  private observedPhysicalPrefix(next: string): number {
    const keys = this.compositionKeys;
    const old = this.editor;
    if (!this.composing || !keys || !old.endsWith(keys) || !next.startsWith(this.compositionStartEditor)) return 0;
    const physicalStart = old.length - keys.length;
    for (let count = keys.length; count > 0;) {
      if (next.endsWith(keys.slice(0, count))) {
        for (let i = 0; i < count; i += keys.codePointAt(i)! > 0xffff ? 2 : 1) {
          if (!this.origins[physicalStart + i]) return 0;
        }
        return count;
      }
      const last = keys.charCodeAt(count - 1);
      count -= last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
    }
    return 0;
  }
  compositionCorrection(finalEditor: string): number {
    if (!this.composing || !finalEditor.startsWith(this.compositionStartEditor)) return 0;
    const start = this.compositionStartEditor.length;
    let surviving = 0;
    // IME candidates may precede physical keys in the editor even though the
    // physical key was already sent. Only a missing tail can be safely erased.
    const keys = this.compositionKeys;
    for (let i = start; i < finalEditor.length;) {
      const codePoint = finalEditor.codePointAt(i)!;
      const width = codePoint > 0xffff ? 2 : 1;
      if (keys.codePointAt(surviving) === codePoint) surviving += width;
      else {
        for (let j = surviving + (keys.codePointAt(surviving)! > 0xffff ? 2 : 1); j < keys.length;
          j += keys.codePointAt(j)! > 0xffff ? 2 : 1) {
          if (keys.codePointAt(j) === codePoint) return 0;
        }
      }
      i += width;
    }
    let missing = 0;
    for (let i = surviving; i < keys.length; i += keys.codePointAt(i)! > 0xffff ? 2 : 1) missing++;
    return missing;
  }
  unreportedCompositionText(text: string, finalEditor: string): string {
    if (!this.composing || !this.compositionKeys || !text || !finalEditor.endsWith(text)) return text;
    // A final candidate can replace only the CJK part after the last native
    // input. Map unchanged prefix/suffix positions back to observed key origins.
    const old = this.editor;
    let prefix = 0;
    while (prefix < old.length && prefix < finalEditor.length &&
      old.codePointAt(prefix) === finalEditor.codePointAt(prefix)) {
      prefix += old.codePointAt(prefix)! > 0xffff ? 2 : 1;
    }
    let oldEnd = old.length;
    let newEnd = finalEditor.length;
    while (oldEnd > prefix && newEnd > prefix && old.charCodeAt(oldEnd - 1) === finalEditor.charCodeAt(newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }
    // A changed candidate can erase the literal suffix alignment above;
    // retain only the observed physical prefix still ending the editor.
    const carried = this.compositionKeys.slice(0, this.observedPhysicalPrefix(finalEditor));
    const start = finalEditor.length - text.length;
    let matched = 0;
    let unsent = "";
    for (let i = 0; i < text.length;) {
      const codePoint = text.codePointAt(i)!;
      const width = codePoint > 0xffff ? 2 : 1;
      const character = text.slice(i, i + width);
      const position = start + i;
      const oldPosition = position < prefix ? position : position >= newEnd ? position + oldEnd - newEnd : -1;
      const carriedPosition = position - (finalEditor.length - carried.length);
      const reported = (oldPosition >= 0 && !!this.origins[oldPosition]) ||
        (carriedPosition >= 0 && carriedPosition + width <= carried.length &&
          carried.codePointAt(carriedPosition) === codePoint);
      const keyIndex = reported ? this.compositionKeys.indexOf(character, matched) : -1;
      if (keyIndex >= 0) matched = keyIndex + width;
      else unsent += character;
      i += width;
    }
    return unsent;
  }

  endComposition(cancelled: boolean): number {
    const checkpoint = this.composition;
    const erased = cancelled ? this.compositionCorrection(this.editor) : 0;
    this.composition = null;
    this.composing = false;
    this.compositionKeys = "";
    this.compositionStartEditor = "";
    // A canceled provisional candidate must not revoke an earlier reported
    // glyph if the native editor restored that original prefix.
    if (cancelled && checkpoint && this.editor.startsWith(checkpoint.editor)) this.origins.set(checkpoint.origins);
    return erased;
  }

  noteKey(key: string, repeat = false, code = key): void {
    this.pendingKey = (this.pendingKey ?? "") + key;
    let codes = this.pressedCodes.get(code);
    if (!codes) {
      codes = [];
      this.pressedCodes.set(code, codes);
    }
    const held = repeat ? codes[codes.length - 1] : null;
    const press = held?.find((entry) => entry.key === key);
    if (press) {
      press.unobserved++;
    } else {
      const created: AndroidPhysicalPress = { key, observed: 0, unobserved: 1 };
      if (held) held.push(created);
      else codes.push([created]);
      let presses = this.pressedKeys.get(key);
      if (!presses) {
        presses = [];
        this.pressedKeys.set(key, presses);
      }
      presses.push(created);
    }
  }

  clearUnobservedKeys(key: string, code = key): void {
    const codes = this.pressedCodes.get(code);
    if (!codes?.length) return;
    // With no stable code, the release glyph may change with Shift. Retire
    // all anonymous presses rather than attribute a later soft edit to one.
    const releases = code ? 1 : codes.length;
    let pending = this.pendingKey;
    for (let i = 0; i < releases; i++) {
      const group = codes.shift()!;
      // Release this code's press, not another held key with the same glyph.
      for (const press of group) {
        const presses = this.pressedKeys.get(press.key);
        const at = presses?.indexOf(press) ?? -1;
        if (at >= 0) presses!.splice(at, 1);
        if (presses && !presses.length) this.pressedKeys.delete(press.key);
        for (let remaining = press.unobserved; pending && remaining > 0; remaining--) {
          const at = pending.indexOf(press.key);
          if (at < 0) break;
          pending = pending.slice(0, at) + pending.slice(at + press.key.length);
        }
      }
    }
    if (!codes.length) this.pressedCodes.delete(code);
    this.pendingKey = pending || null;
  }

  retirePendingKeys(): void {
    // Focus loss can route the keyup to another element. Keep editor origins
    // already observed remotely but retire unresolved keydowns.
    this.pendingKey = null;
    this.pressedKeys.clear();
    this.pressedCodes.clear();
  }

  private markPhysical(index: number, key: string): void {
    this.origins[index] = 1;
    const presses = this.pressedKeys.get(key);
    if (presses) for (const press of presses) {
      if (!press.unobserved) continue;
      press.unobserved--;
      press.observed++;
      break;
    }
    if (this.composing) this.compositionKeys += key;
  }
  normalizedTailReplacement(next: string): AndroidTextChange | null {
    const old = this.editor;
    if (!old) return null;
    const last = old.charCodeAt(old.length - 1);
    const width = last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
    const removedAt = old.length - width;
    if (this.origins[removedAt] || next.length !== removedAt || !old.startsWith(next)) return null;
    let start = removedAt;
    while (start > 0 && !this.origins[start]) {
      const previous = old.charCodeAt(start - 1);
      start -= previous >= 0xdc00 && previous <= 0xdfff ? 2 : 1;
    }
    if (!this.origins[start]) return null;
    const before = composeJamoSequence(old.slice(start));
    const after = composeJamoSequence(next.slice(start));
    // A suffix folded into one SSH scalar must be replaced atomically: an
    // ordinary native DEL for its second source code point would emit zero.
    if (before.length !== (before.codePointAt(0)! > 0xffff ? 2 : 1)
      || after.length !== (after.codePointAt(0)! > 0xffff ? 2 : 1)
      || before === after) return null;
    return { erase: 1, text: after };
  }


  reportedDeletes(next: string, selectionStart = -1, selectionEnd = -1, beforeValue = ""): number {
    return this.countReportedDeletes(this.editor, this.origins, next, selectionStart, selectionEnd, beforeValue);
  }

  reportedCompositionDeletes(next: string): number {
    const checkpoint = this.composition;
    return checkpoint ? this.countReportedDeletes(checkpoint.editor, checkpoint.origins, next,
      checkpoint.selectionStart, checkpoint.selectionEnd, checkpoint.editor) : 0;
  }

  private countReportedDeletes(
    old: string, origins: Uint8Array, next: string,
    selectionStart = -1, selectionEnd = -1, beforeValue = ""
  ): number {
    if (!old || (old === next && !(beforeValue === old && selectionStart >= 0 && selectionEnd > selectionStart))) return 0;
    let start = 0;
    let oldEnd = old.length;
    if (beforeValue === old && selectionStart >= 0 && selectionEnd >= selectionStart && selectionEnd <= old.length) {
      start = selectionStart;
      if (start === selectionEnd && start > 0) {
        const last = old.charCodeAt(start - 1);
        start -= last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
      }
      oldEnd = selectionEnd;
      const prefix = old.slice(0, start);
      const suffix = old.slice(oldEnd);
      // A selected replacement owns the whole selected range even when its
      // new text happens to end with the same glyph as the deleted old text.
      if (next !== prefix + suffix &&
        !(selectionEnd > selectionStart && next.startsWith(prefix) && next.endsWith(suffix))) start = -1;
    } else {
      start = -1;
    }
    if (start < 0) {
      start = 0;
      while (start < old.length && start < next.length && old.codePointAt(start) === next.codePointAt(start)) {
        start += old.codePointAt(start)! > 0xffff ? 2 : 1;
      }
      if (ambiguousDeletion(old, next, start)) return 0;
      let newEnd = next.length;
      while (oldEnd > start && newEnd > start) {
        const prevOld = oldEnd - (old.charCodeAt(oldEnd - 1) >= 0xdc00 && old.charCodeAt(oldEnd - 1) <= 0xdfff ? 2 : 1);
        const prevNew = newEnd - (next.charCodeAt(newEnd - 1) >= 0xdc00 && next.charCodeAt(newEnd - 1) <= 0xdfff ? 2 : 1);
        if (old.codePointAt(prevOld) !== next.codePointAt(prevNew)) break;
        oldEnd = prevOld;
        newEnd = prevNew;
      }
    }
    // A terminal DEL can remove only the last remotely reported text.
    for (let i = oldEnd; i < old.length; i++) if (origins[i]) return 0;
    let removed = 0;
    for (let i = start; i < oldEnd; i++) removed += origins[i];
    return removed;
  }

  private markReportedText(start: number, text: string): void {
    const emitted = composeJamoSequence(text);
    if (emitted === text) {
      for (let i = 0; i < text.length;) {
        this.origins[start + i] = 1;
        i += text.codePointAt(i)! > 0xffff ? 2 : 1;
      }
      return;
    }
    // The actual SSH text is NFC/Jamo-composed. Attribute each emitted
    // scalar to its source prefix, not each unnormalized textarea code point.
    let sent = 0;
    for (let i = 0; i < text.length;) {
      const width = text.codePointAt(i)! > 0xffff ? 2 : 1;
      let count = 0;
      for (const _ of composeJamoSequence(text.slice(0, i + width))) count++;
      if (count > sent) this.origins[start + i] = count - sent;
      else if (count < sent) {
        let excess = sent - count;
        for (let j = start + i - 1; excess > 0 && j >= start; j--) {
          const removed = Math.min(excess, this.origins[j]);
          this.origins[j] -= removed;
          excess -= removed;
        }
      }
      sent = count;
      i += width;
    }
  }

  sync(next: string, selectionStart = -1, selectionEnd = -1, beforeValue = "", conservativeDelete = false, reportedText = ""): string | null {
    const old = this.editor;
    let matched: string | null = null;
    if (old === next) {
      // A selected IME replacement can leave the text identical while
      // changing which key owns it. An unchanged deletion is not a replacement.
      if (!conservativeDelete && beforeValue === old && selectionStart >= 0 &&
        selectionEnd > selectionStart && selectionEnd <= old.length) {
        // Identical selected text is still the same remote glyph unless a
        // physical press or an emitted replacement takes ownership of it.
        const selected = next.slice(selectionStart, selectionEnd);
        const pendingAt = selected ? this.pendingKey?.lastIndexOf(selected) ?? -1 : -1;
        if (pendingAt >= 0) {
          for (let i = 0; i < selected.length;) {
            const width = selected.codePointAt(i)! > 0xffff ? 2 : 1;
            this.markPhysical(selectionStart + i, selected.slice(i, i + width));
            i += width;
          }
          this.pendingKey = this.pendingKey!.slice(0, pendingAt) +
            this.pendingKey!.slice(pendingAt + selected.length) || null;
          return selected;
        }
        if (reportedText && next.slice(selectionStart, selectionEnd) === reportedText) {
          this.origins.fill(0, selectionStart, selectionEnd);
          this.markReportedText(selectionStart, reportedText);
        }
      }
      if (reportedText && next.endsWith(reportedText) && next.indexOf(reportedText) === next.length - reportedText.length) {
        this.markReportedText(next.length - reportedText.length, reportedText);
      }
      // A no-op candidate update can precede this key's native echo.
      return matched;
    }
    // A selected equal-prefix edit may be implemented as an append on the PTY.
    // If the reported text is exactly that suffix, the old remote prefix was
    // never erased and must keep its ownership for subsequent Backspaces.
    if (!conservativeDelete && reportedText && next.length === old.length + reportedText.length &&
      next.startsWith(old) && next.endsWith(reportedText)) {
      selectionStart = -1;
      selectionEnd = -1;
    }
    let prefix = 0;
    let oldEnd = old.length;
    let newEnd = next.length;
    let locatedEdit = false;
    if (beforeValue === old && selectionStart >= 0 && selectionEnd >= selectionStart && selectionEnd <= old.length) {
      let start = selectionStart;
      if (conservativeDelete && start === selectionEnd && start > 0) {
        const last = old.charCodeAt(start - 1);
        start -= last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
      }
      const insertedLength = next.length - old.length + selectionEnd - start;
      if (insertedLength >= 0 && next.startsWith(old.slice(0, start)) && next.endsWith(old.slice(selectionEnd))) {
        prefix = start;
        oldEnd = selectionEnd;
        newEnd = start + insertedLength;
        locatedEdit = true;
      }
    }
    if (!locatedEdit) {
      while (prefix < old.length && prefix < next.length && old.codePointAt(prefix) === next.codePointAt(prefix)) {
        prefix += old.codePointAt(prefix)! > 0xffff ? 2 : 1;
      }
      while (oldEnd > prefix && newEnd > prefix) {
        const oldStart = oldEnd - (old.charCodeAt(oldEnd - 1) >= 0xdc00 && old.charCodeAt(oldEnd - 1) <= 0xdfff ? 2 : 1);
        const newStart = newEnd - (next.charCodeAt(newEnd - 1) >= 0xdc00 && next.charCodeAt(newEnd - 1) <= 0xdfff ? 2 : 1);
        if (old.codePointAt(oldStart) !== next.codePointAt(newStart)) break;
        oldEnd = oldStart;
        newEnd = newStart;
      }
    }
    // When a native candidate changes before an observed physical tail,
    // a canceled trailing key prevents the usual common-suffix mapping.
    // Carry only the surviving physical prefix, never a reordered key.
    const carriedPhysical = this.observedPhysicalPrefix(next);
    const ambiguousDelete = conservativeDelete && !locatedEdit && ambiguousDeletion(old, next, prefix);
    if (next.length > this.origins.length) {
      const grown = new Uint8Array(Math.max(next.length, this.origins.length * 2));
      grown.set(this.origins.subarray(0, old.length));
      this.origins = grown;
    }
    this.origins.copyWithin(newEnd, oldEnd, old.length);
    this.origins.fill(0, prefix, newEnd);
    if (reportedText) {
      const index = next.lastIndexOf(reportedText, newEnd - reportedText.length);
      if (index >= prefix && index + reportedText.length <= newEnd) this.markReportedText(index, reportedText);
    }
    if (carriedPhysical && !ambiguousDelete) {
      for (let i = 0; i < carriedPhysical; i += this.compositionKeys.codePointAt(i)! > 0xffff ? 2 : 1) {
        this.origins[next.length - carriedPhysical + i] = 1;
      }
    }
    if (this.pendingKey) {
      let pending = this.pendingKey;
      for (let i = prefix; i < newEnd && pending;) {
        const width = next.codePointAt(i)! > 0xffff ? 2 : 1;
        const key = next.slice(i, i + width);
        const at = pending.indexOf(key);
        if (at >= 0) {
          this.markPhysical(i, key);
          matched = (matched ?? "") + key;
          pending = pending.slice(0, at) + pending.slice(at + width);
        }
        i += width;
      }
      this.pendingKey = pending || null;
    }
    if (ambiguousDelete) this.origins.fill(0, 0, next.length);
    this.editor = next;
    // Keep unmatched physical presses for the next native edit.
    return matched;
  }
  compact(retained: string): void {
    const dropped = this.editor.length - retained.length;
    if (dropped < 0 || this.editor.slice(dropped) !== retained) {
      this.reset();
      this.editor = retained;
      return;
    }
    if (this.origins.length > 1024) {
      const trimmed = new Uint8Array(Math.max(512, retained.length));
      trimmed.set(this.origins.subarray(dropped, this.editor.length));
      this.origins = trimmed;
    } else {
      this.origins.copyWithin(0, dropped, this.editor.length);
      this.origins.fill(0, retained.length, this.editor.length);
    }
    this.editor = retained;
    this.pendingKey = null;
    this.pressedKeys.clear();
    this.pressedCodes.clear();
  }


  reset(): void {
    if (this.origins.length > 1024) this.origins = new Uint8Array(512);
    else this.origins.fill(0, 0, this.editor.length);
    this.editor = "";
    this.pendingKey = null;
    this.pressedKeys.clear();
    this.pressedCodes.clear();
    this.composition = null;
    this.composing = false;
    this.compositionKeys = "";
    this.compositionStartEditor = "";
  }
}
