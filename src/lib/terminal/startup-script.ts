export function buildStartupScriptPayload(script?: string | null): string | null {
  if (script == null) return null;

  const normalized = script.replace(/\r\n?/g, "\n");
  if (normalized.trim().length === 0) return null;

  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }

  return `${lines.join("\r")}\r`;
}

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|P[\s\S]*?(?:\x1B\\))/g;

function visibleOutput(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

export interface StartupScriptDispatcher {
  takeImmediatePayload(): string | null;
  consumeOutput(text: string): string | null;
}

export function createStartupScriptDispatcher(
  script?: string | null,
  readyText?: string | null
): StartupScriptDispatcher {
  const payload = buildStartupScriptPayload(script);
  const trigger = readyText?.trim() ?? "";
  let sent = false;
  let rawOutputBuffer = "";

  function takePayload(): string | null {
    if (!payload || sent) return null;
    sent = true;
    return payload;
  }

  return {
    takeImmediatePayload() {
      if (trigger) return null;
      return takePayload();
    },

    consumeOutput(text: string) {
      if (!trigger || !text) return null;
      rawOutputBuffer = `${rawOutputBuffer}${text}`.slice(-Math.max(8192, trigger.length * 4));
      if (!visibleOutput(rawOutputBuffer).includes(trigger)) return null;
      return takePayload();
    },
  };
}
