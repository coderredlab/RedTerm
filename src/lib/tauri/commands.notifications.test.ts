// @ts-nocheck -- Bun tests follow the repository's test convention; app tsconfig has no Bun types.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('OSC 99 reaches the notification API with shared cooldown, permissions and stale-session checks', () => {
  // Isolate globals and module mocks used by other IPC tests. The real notification
  // plugin calls this Notification constructor, just as it does in the WebView.
  const result = spawnSync(process.execPath, ['--eval', `
    import assert from 'node:assert/strict';
    import { AnsiParser } from './src/lib/terminal/ansi-parser.ts';
    import { sendDesktopTerminalNotification, sendDesktopBellNotification } from './src/lib/tauri/commands.ts';
    const sent = [];
    let requests = 0;
    let now = 10000;
    Date.now = () => now;
    let releasePermission;
    class Notification {
      static permission = 'granted';
      static requestPermission() {
        requests++;
        return new Promise(resolve => { releasePermission = resolve; });
      }
      constructor(title, options) { sent.push({ title, body: options.body }); }
    }
    globalThis.window = { Notification };
    globalThis.Notification = Notification;
    const parser = new AnsiParser(80, 24);
    parser.setNotificationSupport(true);
    let delivery;
    parser.setOscEventHandler(event => {
      if (event.type === 'notification') delivery = sendDesktopTerminalNotification(event.notification.title, event.notification.body);
    });
    parser.write('\\x1b]99;i=1:d=0;Build complete\\x1b\\\\');
    assert.equal(sent.length, 0);
    parser.write('\\x1b]99;i=1:p=body;All checks passed\\x1b\\\\');
    await delivery;
    assert.deepEqual(sent, [{ title: 'Build complete', body: 'All checks passed' }]);
    await sendDesktopBellNotification('Local shell');
    assert.equal(sent.length, 1);
    now += 2000;
    await sendDesktopBellNotification('Local shell');
    assert.equal(sent[1].title, 'Local shell: terminal bell');
    now += 2000;
    Notification.permission = 'denied';
    let active = true;
    const pending = sendDesktopTerminalNotification('Stale', 'Message', () => active);
    while (!releasePermission) await new Promise(resolve => setTimeout(resolve, 0));
    await sendDesktopTerminalNotification('Concurrent', 'Message');
    assert.equal(requests, 1);
    active = false;
    releasePermission('granted');
    await pending;
    assert.equal(sent.length, 2);
    Notification.permission = 'granted';
    await sendDesktopTerminalNotification('Live', 'Message');
    assert.equal(sent.length, 3);
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
});
