// @ts-nocheck -- Bun tests follow the repository's test convention; app tsconfig has no Bun types.
import { describe, expect, test } from 'bun:test';
import { AnsiParser, type TerminalOscEvent } from './ansi-parser';
import { OscNotifications, shouldShowTerminalNotification } from './osc-notifications';

const osc = (payload: string) => `\x1b]99;${payload}\x1b\\`;

function terminal(enabled = true) {
  const parser = new AnsiParser(80, 24);
  const events: TerminalOscEvent[] = [];
  const responses: string[] = [];
  parser.setNotificationSupport(enabled);
  parser.setOscEventHandler((event) => events.push(event));
  parser.setResponseHandler((response) => responses.push(response));
  return { parser, events, responses };
}

describe('OSC 99 notifications', () => {
  test('emits a simple title through the ANSI parser without ringing BEL', () => {
    const { parser, events } = terminal();
    let bells = 0;
    parser.setBellHandler(() => bells++);
    parser.write('\x1b]99;;Build finished\x07');
    expect(events).toEqual([{ type: 'notification', notification: { title: 'Build finished', body: '', occasion: 'always' } }]);
    expect(bells).toBe(0);
  });

  test('assembles Herdr title/body at every transport boundary', () => {
    const sequence = osc('i=1:d=0;Build finished') + osc('i=1:p=body;All checks passed');
    for (let boundary = 0; boundary <= sequence.length; boundary++) {
      const { parser, events } = terminal();
      parser.write(sequence.slice(0, boundary));
      parser.write(sequence.slice(boundary));
      expect(events).toEqual([{ type: 'notification', notification: { title: 'Build finished', body: 'All checks passed', occasion: 'always' } }]);
    }
  });

  test('keeps interleaved identifiers separate and uses a body-only title', () => {
    const receiver = new OscNotifications();
    receiver.receive('i=a:d=0;First');
    receiver.receive('i=b:d=0:o=unfocused;Second');
    expect(receiver.receive('i=a:p=body;Body').notification?.title).toBe('First');
    expect(receiver.receive('i=b;p').notification).toEqual({ title: 'Secondp', body: '', occasion: 'unfocused' });
    expect(receiver.receive('p=body;Only body').notification).toEqual({ title: 'Only body', body: '', occasion: 'always' });
  });

  test('decodes base64 split after encoding, including UTF-8 and padding boundaries', () => {
    const encoded = Buffer.from('완료 🐱\nReady').toString('base64');
    for (let boundary = 0; boundary <= encoded.length; boundary++) {
      const receiver = new OscNotifications();
      receiver.receive(`i=a:e=1:d=0;${encoded.slice(0, boundary)}`);
      expect(receiver.receive(`i=a:e=1;${encoded.slice(boundary)}`).notification?.title).toBe('완료 🐱\nReady');
    }
    expect(new OscNotifications().receive('e=1;T0s').notification?.title).toBe('OK');
  });

  test('accepts individually padded base64 chunks', () => {
    const receiver = new OscNotifications();
    receiver.receive('i=a:e=1:d=0;QQ==');
    expect(receiver.receive('i=a:e=1;Qg==').notification?.title).toBe('AB');
  });

  test('ignores unknown metadata/payloads but finalizes accumulated text', () => {
    const receiver = new OscNotifications();
    receiver.receive('i=a:d=0:z=future;Hello');
    expect(receiver.receive('i=a:p=icon;ignored').notification?.title).toBe('Hello');
    expect(receiver.receive('p=icon;ignored')).toEqual({});
  });

  test('advertises only implemented payloads and occasions with a safe identifier', () => {
    const { parser, events, responses } = terminal();
    parser.write(osc('i=query-1:p=?;'));
    expect(responses).toEqual([osc('i=query-1:p=?;p=title,body:o=always,unfocused,invisible')]);
    parser.write(osc('i=bad id:p=?;'));
    expect(responses.length).toBe(1);
    expect(events).toEqual([]);
  });

  test('does not advertise or emit when the host has no notification support', () => {
    const { parser, events, responses } = terminal(false);
    parser.write(osc('p=?;') + osc(';Hello'));
    expect(events).toEqual([]);
    expect(responses).toEqual([]);
  });

  test('rejects malformed text and recovers for a new valid message', () => {
    for (const payload of ['e=1;***', 'e=1;/w==', 'e=1;A===', ';bad\x00text', 'd=3;invalid']) {
      const receiver = new OscNotifications();
      expect(receiver.receive(payload)).toEqual({});
      expect(receiver.receive(';Valid').notification?.title).toBe('Valid');
    }
  });

  test('bounds accumulated chunks and discards the rejected notification until done', () => {
    const receiver = new OscNotifications();
    for (let n = 0; n < 9; n++) receiver.receive(`i=a:d=0;${'x'.repeat(2048)}`);
    expect(receiver.receive('i=a:p=body;End')).toEqual({});
    expect(receiver.receive('i=a;New').notification?.title).toBe('New');
  });

  test('replayed and restored OSC sequences do not produce notifications', () => {
    const { parser, events, responses } = terminal();
    parser.writeReplay(osc(';Old') + osc('p=?;') + '\x1b]99;;Partial');
    parser.write('\x1b\\');
    expect(events).toEqual([]);
    expect(responses).toEqual([osc('i=0:p=?;p=title,body:o=always,unfocused,invisible')]);
    parser.write(osc(';Live'));
    expect(events.length).toBe(1);
    parser.write('\x1b]99;;Snapshot');
    const snapshot = parser.createSnapshot();
    const restored = terminal();
    restored.parser.restoreSnapshot(snapshot);
    restored.parser.write('\x1b\\');
    expect(restored.events.filter((event) => event.type === 'notification')).toEqual([]);
  });

  test('honors occasion conditions', () => {
    expect(shouldShowTerminalNotification('always', true, true, true)).toBe(true);
    expect(shouldShowTerminalNotification('unfocused', true, true, true)).toBe(false);
    expect(shouldShowTerminalNotification('unfocused', false, true, true)).toBe(true);
    expect(shouldShowTerminalNotification('invisible', true, true, false)).toBe(true);
    expect(shouldShowTerminalNotification('invisible', true, true, true)).toBe(false);
    expect(shouldShowTerminalNotification('invisible', false, true, true)).toBe(false);
  });
});
