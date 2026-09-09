export type NotificationOccasion = 'always' | 'unfocused' | 'invisible';

export interface TerminalNotification {
  title: string;
  body: string;
  occasion: NotificationOccasion;
}

interface TextPart {
  encoded: boolean;
  value: string;
}

interface PendingNotification {
  title: TextPart[];
  body: TextPart[];
  occasion: NotificationOccasion;
  bytes: number;
  rejected: boolean;
}

const MAX_PENDING = 16;
const MAX_TEXT_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** OSC 99 text notifications. State belongs to one live terminal, never a snapshot. */
export class OscNotifications {
  private pending = new Map<string, PendingNotification>();

  clear() {
    this.pending.clear();
  }

  receive(payload: string): { notification?: TerminalNotification; response?: string } {
    const separator = payload.indexOf(';');
    if (separator < 0 || separator > 1024) return {};
    const metadata = new Map<string, string>();
    for (const part of payload.slice(0, separator).split(':')) {
      if (!part) continue;
      const match = /^([a-zA-Z])=([\x21-\x3a\x3c-\x7e]*)$/.exec(part);
      if (!match) return {};
      metadata.set(match[1], match[2]);
    }
    const id = metadata.get('i') ?? '';
    if (id.length > 128 || !/^[a-zA-Z0-9_+.-]*$/.test(id)) return {};
    const type = metadata.get('p') ?? 'title';
    if (type === '?') {
      return { response: `\x1b]99;i=${id || '0'}:p=?;p=title,body:o=always,unfocused,invisible\x1b\\` };
    }
    // Lifecycle requests require OS notification tracking, which is not advertised.
    if (type === 'alive' || type === 'close') return {};

    let pending = this.pending.get(id);
    if (!pending) {
      if (this.pending.size >= MAX_PENDING) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      pending = { title: [], body: [], occasion: 'always', bytes: 0, rejected: false };
    }
    const done = metadata.get('d') ?? '1';
    const encoding = metadata.get('e') ?? '0';
    if (!['0', '1'].includes(done) || !['0', '1'].includes(encoding)) pending.rejected = true;
    const occasion = metadata.get('o');
    if (occasion === 'always' || occasion === 'unfocused' || occasion === 'invisible') {
      pending.occasion = occasion;
    }

    if (!pending.rejected && (type === 'title' || type === 'body')) {
      try {
        const text = payload.slice(separator + 1);
        const encoded = encoding === '1';
        const bytes = encoder.encode(text).length;
        if (bytes > (encoded ? 4096 : 2048) || pending.bytes + bytes > MAX_TEXT_BYTES ||
          (encoded ? !/^[A-Za-z0-9+/=]*$/.test(text) : /[\x00-\x1f\x7f-\x9f]/.test(text))) {
          throw new Error('Invalid notification text');
        }
        pending.bytes += bytes;
        if (text) {
          const parts = pending[type];
          const previous = parts[parts.length - 1];
          if (previous?.encoded === encoded) previous.value += text;
          else if (parts.length < 256) parts.push({ encoded, value: text });
          else throw new Error('Too many notification fragments');
        }
      } catch {
        pending.rejected = true;
        pending.title = [];
        pending.body = [];
      }
    }

    if (done === '0') {
      this.pending.set(id, pending);
      return {};
    }
    this.pending.delete(id);
    if (pending.rejected) return {};
    try {
      const title = decodeParts(pending.title);
      const body = decodeParts(pending.body);
      if (!title && !body) return {};
      return { notification: { title: title || body, body: title ? body : '', occasion: pending.occasion } };
    } catch {
      return {};
    }
  }
}

function decodeParts(parts: TextPart[]): string {
  return parts.map(({ encoded, value }) => {
    if (!encoded) return value;
    // Padding delimits chunks encoded individually; unpadded chunks concatenate.
    const groups = value.match(/[A-Za-z0-9+/]+={0,2}/g) ?? [];
    if (groups.join('') !== value) throw new Error('Invalid base64');
    const bytes: number[] = [];
    for (const group of groups) {
      const binary = atob(group);
      for (let i = 0; i < binary.length; i++) bytes.push(binary.charCodeAt(i));
    }
    return decoder.decode(Uint8Array.from(bytes)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  }).join('');
}

export function shouldShowTerminalNotification(
  occasion: NotificationOccasion,
  interactive: boolean,
  focused: boolean,
  visible: boolean,
): boolean {
  if (occasion === 'always') return true;
  if (occasion === 'unfocused') return !interactive || !focused;
  return !focused || !visible;
}
