export class SshOutputDecoder {
  private decoder = new TextDecoder();
  private pendingBytes = new Uint8Array();

  decode(chunk: Uint8Array): string {
    const bytes = this.pendingBytes.length === 0
      ? chunk
      : SshOutputDecoder.concat(this.pendingBytes, chunk);
    const pendingLength = SshOutputDecoder.incompleteUtf8SuffixLength(bytes);
    const completeLength = bytes.length - pendingLength;
    this.pendingBytes = pendingLength === 0
      ? new Uint8Array()
      : bytes.slice(completeLength);
    return completeLength === 0
      ? ""
      : this.decoder.decode(bytes.subarray(0, completeLength), { stream: true });
  }

  getPendingBytes(): number[] {
    return Array.from(this.pendingBytes);
  }

  restorePendingBytes(bytes: readonly number[] | undefined): void {
    if (
      !bytes ||
      bytes.length > 3 ||
      bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
    ) {
      this.pendingBytes = new Uint8Array();
      return;
    }
    const restored = Uint8Array.from(bytes);
    this.pendingBytes =
      SshOutputDecoder.incompleteUtf8SuffixLength(restored) === restored.length
        ? restored
        : new Uint8Array();
  }

  reset(): void {
    this.decoder = new TextDecoder();
    this.pendingBytes = new Uint8Array();
  }

  private static concat(left: Uint8Array, right: Uint8Array): Uint8Array {
    const combined = new Uint8Array(left.length + right.length);
    combined.set(left);
    combined.set(right, left.length);
    return combined;
  }

  private static incompleteUtf8SuffixLength(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0;
    let leadIndex = bytes.length - 1;
    while (
      leadIndex >= 0 &&
      bytes[leadIndex] >= 0x80 &&
      bytes[leadIndex] <= 0xbf &&
      bytes.length - leadIndex <= 3
    ) {
      leadIndex--;
    }
    if (leadIndex < 0) return 0;
    const lead = bytes[leadIndex];
    const expectedLength = lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
    const actualLength = bytes.length - leadIndex;
    if (expectedLength === 0 || actualLength >= expectedLength) return 0;
    for (let index = leadIndex + 1; index < bytes.length; index++) {
      if (bytes[index] < 0x80 || bytes[index] > 0xbf) return 0;
    }
    const second = bytes[leadIndex + 1];
    if (
      second !== undefined &&
      ((lead === 0xe0 && second < 0xa0) ||
        (lead === 0xed && second > 0x9f) ||
        (lead === 0xf0 && second < 0x90) ||
        (lead === 0xf4 && second > 0x8f))
    ) {
      return 0;
    }
    return actualLength;
  }
}
