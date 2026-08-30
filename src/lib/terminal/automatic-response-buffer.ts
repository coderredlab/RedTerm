const DEFAULT_MAX_RESPONSES = 1024;
const DEFAULT_MAX_CHARACTERS = 64 * 1024;

export class AutomaticResponseBuffer {
  private responses: string[] = [];
  private characterCount = 0;

  constructor(
    private readonly maxResponses = DEFAULT_MAX_RESPONSES,
    private readonly maxCharacters = DEFAULT_MAX_CHARACTERS,
  ) {}

  enqueue(response: string): boolean {
    if (response.length === 0) return false;
    if (
      this.responses.length >= this.maxResponses ||
      this.characterCount + response.length > this.maxCharacters
    ) return false;

    this.responses.push(response);
    this.characterCount += response.length;
    return true;
  }

  drain(): string {
    const batch = this.responses.join("");
    this.clear();
    return batch;
  }

  clear() {
    this.responses.length = 0;
    this.characterCount = 0;
  }
}
