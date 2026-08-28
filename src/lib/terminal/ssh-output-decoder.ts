export class SshOutputDecoder {
  private decoder = new TextDecoder();

  decode(chunk: Uint8Array): string {
    return this.decoder.decode(chunk, { stream: true });
  }

  reset(): void {
    this.decoder = new TextDecoder();
  }
}
