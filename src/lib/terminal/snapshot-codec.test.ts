// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { AnsiParser, type TerminalSnapshot } from './ansi-parser';
import { decodeTerminalSnapshot, encodeTerminalSnapshot } from './snapshot-codec';
import { SshOutputDecoder } from './ssh-output-decoder';
import {
  invalidateLocalSnapshotWrite, scheduleLocalSnapshotWrite, storeRuntimeSessionSnapshot,
  takeLocalSnapshotWrite, takeRuntimeSessionSnapshot,
} from './session-runtime-snapshot';

function roundTrip(snapshot: TerminalSnapshot): TerminalSnapshot {
  const decoded = decodeTerminalSnapshot(JSON.parse(JSON.stringify(encodeTerminalSnapshot(snapshot))));
  if (!decoded) throw new Error('Snapshot failed to decode');
  return decoded;
}
function restore(snapshot: TerminalSnapshot): AnsiParser {
  const parser = new AnsiParser(20, 4);
  parser.restoreSnapshot(snapshot);
  return parser;
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';

describe('compact terminal snapshots', () => {
  test('restores main and alternate screens, OSC66, hyperlinks and terminal modes', () => {
    const parser = new AnsiParser(20, 4);
    parser.write('\x1b]2;build\x07\x1b]7;file://host/project\x07');
    parser.write('\x1b]8;id=docs;https://example.com\x1b\\\x1b]66;s=2:w=2;Wide\x07\x1b]8;;\x1b\\');
    parser.write('\x1b[=3u\x1b[?1049h\x1b[>8u\x1b[31m한e\u0301\x1b[?25l\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?2026h');
    const captured = parser.createSnapshot();
    const decoded = roundTrip(captured);
    expect(decoded).toEqual(captured);
    const restored = restore(decoded);
    expect(restored.getBuffer()[0][0].char).toBe('한');
    expect(restored.getKittyKeyboardFlags()).toBe(8);
    restored.write('\x1b[?1049l');
    expect(restored.getKittyKeyboardFlags()).toBe(3);
    expect(restored.getBuffer()[0][0].textSizing?.text).toBe('Wide');
    expect(restored.getBuffer()[0][0].hyperlink?.uri).toBe('https://example.com');
  });

  test('continues incomplete control and image streams at every split boundary', () => {
    const sequences = [
      '\x1b]2;split title\x1b\\',
      '\x1b[38;2;12;34;56mX',
      '\x1b_Ga=T,f=32,s=1,v=1,c=1,r=1;/wAA/w==\x1b\\',
      `\x1b]1337;File=inline=1;width=1;height=1:${png}\x07`,
      '\x1bPq"1;1;1;1#0;2;100;0;0~\x1b\\',
    ];
    for (const sequence of sequences) {
      const expected = new AnsiParser(20, 4);
      expected.write(sequence);
      for (let split = 1; split < sequence.length; split++) {
        const source = new AnsiParser(20, 4);
        source.write(sequence.slice(0, split));
        const resumed = restore(roundTrip(source.createSnapshot()));
        resumed.write(sequence.slice(split));
        expect(resumed.createSnapshot()).toEqual(expected.createSnapshot());
        expect(resumed.getImages()).toEqual(expected.getImages());
      }
    }
  });

  test('continues pending multipart Kitty and iTerm2 payloads with pending UTF8', () => {
    const source = new AnsiParser(20, 4);
    source.write('\x1b_Ga=T,f=32,s=1,v=1,c=1,r=1,m=1;/wAA\x1b\\');
    const decoder = new SshOutputDecoder();
    source.write(decoder.decode(new Uint8Array([0xed, 0x95])));
    const captured = { ...source.createSnapshot(), utf8PendingBytes: decoder.getPendingBytes(), outputOffset: 123 };
    const decoded = roundTrip(captured);
    const resumed = restore(decoded);
    const nextDecoder = new SshOutputDecoder();
    nextDecoder.restorePendingBytes(decoded.utf8PendingBytes);
    resumed.write('\x1b_Gm=0;/w==\x1b\\');
    resumed.write(nextDecoder.decode(new Uint8Array([0x9c])));
    expect(Array.from(resumed.getImages()[0].data)).toEqual([255, 0, 0, 255]);
    expect(resumed.getFullBuffer().flat().some((cell) => cell.char === '한')).toBe(true);
    expect(decoded.outputOffset).toBe(123);

    const iterm = new AnsiParser(20, 4);
    iterm.write('\x1b]1337;MultipartFile=inline=1;width=1;height=1\x07');
    iterm.write(`\x1b]1337;FilePart=${png.slice(0, 20)}\x07`);
    const itermResumed = restore(roundTrip(iterm.createSnapshot()));
    itermResumed.write(`\x1b]1337;FilePart=${png.slice(20)}\x07\x1b]1337;FileEnd\x07`);
    expect(itermResumed.getImages()[0]?.pixelWidth).toBe(1);
  });

  test('preserves Kitty placeholder metadata on the wire but keeps decoded image bytes runtime-only', () => {
    const source = new AnsiParser(20, 4);
    source.write('\x1b_Ga=t,i=94,f=32,s=1,v=1;/wAA/w==\x1b\\');
    source.write('\x1b_Ga=p,i=94,p=1,U=1,c=1,r=1\x1b\\\x1b[38;5;94m\u{10eeee}\x1b[0m');
    const runtime = source.createRuntimeSnapshot();
    const persisted = roundTrip(runtime);
    expect(persisted.bufferRows[0][0].imagePlaceholder).toEqual(runtime.bufferRows[0][0].imagePlaceholder);
    expect(persisted.runtimeImageState).toBeUndefined();
    expect(restore(runtime).getImages()[0]?.data).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
    expect(restore(persisted).getImages()).toEqual([]);
  });

  test('rejects corrupt cell IDs, tuples, geometry and styles', () => {
    const encoded = encodeTerminalSnapshot(new AnsiParser(20, 4).createSnapshot());
    const corrupt: unknown[] = [
      null, [], { ...encoded, version: 3 },
      { ...encoded, buffer: [[[1, 'x']]] },
      { ...encoded, styles: new Array(1) },
      { ...encoded, buffer: new Array(1) },
      { ...encoded, buffer: [[[-1, 'x']]] },
      { ...encoded, buffer: [[[0.5, 'x']]] },
      { ...encoded, buffer: [[[0, 'x', 1000000000]]] },
      { ...encoded, buffer: [[[0, { length: 1000000000 }]]] },
      { ...encoded, buffer: [[[0, 'x'.repeat(65536)]]] },
      { ...encoded, scrollback: Array.from({ length: 50001 }, () => []) },
      { ...encoded, styles: [{ ...encoded.styles[0], bold: 'false' }] },
      { ...encoded, state: { ...encoded.state, cursorX: Infinity } },
    ];
    for (const value of corrupt) expect(decodeTerminalSnapshot(value)).toBeNull();
    expect(decodeTerminalSnapshot({ ...new AnsiParser(20, 4).createSnapshot(), bufferRows: [[null]] })).toBeNull();
  });

  test('keeps screen and modes when captured optional streams cannot be restored', () => {
    const params = ['a=T', 'f=32', 's=1', 'v=1', 'm=1',
      ...Array.from({ length: 27 }, (_, index) => `unused${index}=0`)];
    const streams = [
      `\x1b_G${params.join(',')};/wAA\x1b\\\x1b_Gm=1,q=0;\x1b\\`,
      '\x1b_G' + 'x'.repeat(8192) + '\u{1f642}',
    ];
    for (const stream of streams) {
      const source = new AnsiParser(20, 4);
      source.write('saved\r\n\x1b[?2004h' + stream);
      const snapshot = source.createSnapshot();
      const expected = restore(snapshot);
      const resumed = restore(roundTrip(snapshot));
      expected.write('TAIL');
      resumed.write('TAIL');
      expect(resumed.createSnapshot()).toEqual(expected.createSnapshot());
      expect(resumed.getBuffer()[0].map((cell) => cell.char).join('').trimEnd()).toBe('saved');
      expect(resumed.getBuffer()[1].map((cell) => cell.char).join('').trimEnd()).toBe('TAIL');
      expect(resumed.isBracketedPasteMode()).toBe(true);
    }
  });

  test('recomputes pending payload length without losing a resumable image', () => {
    const source = new AnsiParser(20, 4);
    source.write('saved\r\n\x1b_Ga=T,f=32,s=1,v=1,m=1;/wAA\x1b\\');
    const snapshot = source.createSnapshot();
    snapshot.pendingKittyImage.encodedLength = 999;
    const resumed = restore(roundTrip(snapshot));
    resumed.write('\x1b_Gm=0;/w==\x1b\\');
    expect(resumed.getBuffer()[0].map((cell) => cell.char).join('').trimEnd()).toBe('saved');
    expect(Array.from(resumed.getImages()[0].data)).toEqual([255, 0, 0, 255]);
  });

  test('migrates legacy snapshots without losing pending stream state', () => {
    const parser = new AnsiParser(20, 4);
    parser.write('saved\x1b[31');
    const legacy = JSON.parse(JSON.stringify(parser.createSnapshot()));
    const decoded = decodeTerminalSnapshot(legacy);
    if (!decoded) throw new Error('Legacy migration failed');
    const resumed = restore(roundTrip(decoded));
    resumed.write('mX');
    expect(resumed.getBuffer()[0][5].char).toBe('X');
    expect(resumed.getBuffer()[0][5].style.ansiFgIndex).toBe(1);
  });

  test('shared detached capture survives live and recovered mutations before delayed persistence', () => {
    const parser = new AnsiParser(20, 4);
    parser.write('\x1b]8;;https://example.com\x1b\\saved');
    const runtime = parser.createRuntimeSnapshot();
    storeRuntimeSessionSnapshot('codec-isolation', runtime);
    const { runtimeImageState: _images, ...captured } = runtime;
    let serialized = '';
    const generation = scheduleLocalSnapshotWrite('codec-isolation', () => {
      serialized = JSON.stringify(encodeTerminalSnapshot(captured));
    });
    parser.write('\r\x1b[32mchanged');
    const recovered = takeRuntimeSessionSnapshot('codec-isolation');
    if (!recovered) throw new Error('Runtime capture missing');
    restore(recovered).write('\rresumed');
    takeLocalSnapshotWrite('codec-isolation', generation)?.();
    const decoded = decodeTerminalSnapshot(JSON.parse(serialized));
    if (!decoded) throw new Error('Delayed persistence failed');
    expect(decoded.bufferRows[0].slice(0, 5).map((cell) => cell.char).join('')).toBe('saved');
    expect(decoded.bufferRows[0][0].hyperlink?.uri).toBe('https://example.com');
    expect(decoded.bufferRows[0][0].style.ansiFgIndex).toBeUndefined();

    let writes = 0;
    const stale = scheduleLocalSnapshotWrite('codec-isolation', () => { writes += 1; });
    const latest = scheduleLocalSnapshotWrite('codec-isolation', () => { writes += 10; });
    takeLocalSnapshotWrite('codec-isolation', stale)?.();
    takeLocalSnapshotWrite('codec-isolation', latest)?.();
    const cancelled = scheduleLocalSnapshotWrite('codec-isolation', () => { writes += 100; });
    invalidateLocalSnapshotWrite('codec-isolation');
    takeLocalSnapshotWrite('codec-isolation', cancelled)?.();
    expect(writes).toBe(10);
  });
});
