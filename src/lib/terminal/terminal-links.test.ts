// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { AnsiParser, DEFAULT_STYLE, type Cell } from "./ansi-parser";
import { findUrlAtCell, validateTerminalUrl } from "./terminal-links";
import { findPathAtCell } from "./terminal-paths";

function bufferFromRows(...texts: string[]): Cell[][] {
  return texts.map((text) =>
    [...text].map((char) => ({ char, style: DEFAULT_STYLE }))
  );
}

const oauthUrl = "https://accounts.google.com/o/oauth2/auth?" +
  "client_id=example-client.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A45261%2Foauth%2Fcallback" +
  "&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.readonly+" +
  "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyt-analytics.readonly+" +
  "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.upload" +
  "&access_type=offline&prompt=consent+select_account&state=example-state" +
  "&code_challenge=example-challenge&code_challenge_method=S256";

function renderedOAuth() {
  const width = oauthUrl.indexOf("%2F") + 1;
  const parser = new AnsiParser(width + 22, 12);
  const target = `(${oauthUrl})`;
  const lines = ["\x1b[4mGoogle에서 유튜브 업로드 권한 연결하기\x1b[0m",
    ...Array.from({ length: Math.ceil(target.length / width) }, (_, index) =>
      target.slice(index * width, (index + 1) * width))];
  for (let row = 0; row < 12; row++) {
    const content = lines[row] ?? "";
    parser.write(`\x1b[${row + 1};1H${" ".repeat(17)}│ ${content}`);
    parser.write(`\x1b[${row + 1};${width + 21}H ▕`);
  }
  return { parser, lines, width };
}

test("opens the complete rendered OAuth target from its Korean title and every URI row", () => {
  const { parser, lines } = renderedOAuth();
  for (let row = 0; row < lines.length; row++) {
    expect(findUrlAtCell(parser.getFullBuffer(), { row, col: 22 })?.url).toBe(oauthUrl);
  }
});

function plainPane(lines: string[], width: number, padding = 1) {
  const sidebar = "side │";
  const margin = " ".repeat(padding);
  const parser = new AnsiParser(sidebar.length + width + 2 * padding + 1, lines.length);
  parser.write("\x1b[?1049h");
  lines.forEach((text, row) => {
    parser.write(`\x1b[${row + 1};1H${sidebar}${margin}${text.padEnd(width)}${margin}▕`);
  });
  return { parser, buffer: parser.getFullBuffer(), left: sidebar.length + padding };
}

test("opens a plain pane-wrapped URL from every row, including schemes embedded in its query", () => {
  const scopes = ["drive", "spreadsheets", "gmail.modify", "calendar", "documents", "tasks"]
    .map(scope => `https://www.example.test/auth/${scope}`).join("%20");
  const url = `https://accounts.example.test/o/oauth2/auth?scope=${scopes}` +
    "&redirect_uri=http://localhost:12345&client_id=example&prompt=select_account+consent";
  const printed = `  ${url}`;
  const inner = printed.indexOf("%20https://") + 3;
  for (const width of [inner, inner + "https://w".length]) {
    const chunks = printed.match(new RegExp(`.{1,${width}}`, "g"))!;
    for (const padding of [0, 1]) {
      const { buffer, left } = plainPane(["", ...chunks, "", "cancelled"], width, padding);
      chunks.forEach((chunk, index) => {
        const startCol = left + (index === 0 ? 2 : 0), endCol = left + chunk.length - 1;
        for (const col of [startCol, endCol]) {
          expect(findUrlAtCell(buffer, { row: index + 1, col })).toEqual({ url, startCol, endCol });
        }
        expect(findUrlAtCell(buffer, { row: index + 1, col: endCol + 1 })).toBeNull();
      });
    }
  }
});

test("does not extend a pane URL's host or absorb the next link or a line of prose", () => {
  for (const [first, second] of [
    ["https://example.test", ".other.test/path"],
    ["https://example.test/path", "https://other.test/"],
    ["https://example.test/path", "next command output"],
  ]) {
    const { buffer, left } = plainPane(["", first, second, ""], first.length);
    expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(new URL(first).href);
    expect(findUrlAtCell(buffer, { row: 2, col: left + 8 })?.url ?? null)
      .toBe(second.startsWith("https://") ? second : null);
  }
});

test("keeps independent pane URLs separate after a comma or a percent-encoded path character", () => {
  const first = "https://one.test/report", second = "https://two.test/doc";
  for (const suffix of [",", "%29"]) {
    const printed = first + suffix;
    const { buffer, left } = plainPane(["", printed, second, ""], printed.length);
    for (const [row, url] of [[1, suffix === "," ? first : printed], [2, second]] as const) {
      expect(findUrlAtCell(buffer, { row, col: left + 8 })).toEqual({
        url, startCol: left, endCol: left + url.length - 1,
      });
    }
  }
});

test("never opens the original site or a truncated archive URL at an ambiguous pane boundary", () => {
  const archive = "https://archive.test/web/20240101/", site = "https://source.test/article";
  const { buffer, left } = plainPane(["", archive, site, ""], archive.length, 0);
  for (const row of [1, 2]) {
    expect([null, archive + site]).toContain(findUrlAtCell(buffer, { row, col: left + 8 })?.url ?? null);
  }
});

test("keeps a row-initial URL assigned to a query parameter inside the outer target", () => {
  const prefix = "https://accounts.test/authorize?return_to=", value = "https://app.test/cb&state=ok";
  const { buffer, left } = plainPane(["", prefix, value, ""], prefix.length);
  for (const row of [1, 2]) {
    expect(findUrlAtCell(buffer, { row, col: left + 8 })?.url).toBe(prefix + value);
  }
});

test("does not use a separately parenthesized URL's query as part of the preceding link", () => {
  const first = "https://one.test/search?q=x", second = "https://two.test/?n=1";
  const { buffer, left } = plainPane(["", first, `(${second})`, ""], first.length);
  expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(first);
  expect(findUrlAtCell(buffer, { row: 2, col: left + 8 })?.url).toBe(second);
});

test("does not borrow query ownership evidence across an unused content column", () => {
  const first = "https://one.test/?return_to=";
  const second = "https://two.test/".padEnd(first.length - 1, "x");
  const { buffer, left } = plainPane(["", first, second, "&state=ok", ""], first.length);
  expect(findUrlAtCell(buffer, { row: 2, col: left + 8 })).toBeNull();
  expect(findUrlAtCell(buffer, { row: 3, col: left + 2 })).toBeNull();
});

test("finds an independently separated URL beyond an earlier ambiguous pair", () => {
  const first = "https://one.test/path/", last = "https://three.test/";
  const { buffer, left } = plainPane(["", first, "https://two.test/path", last, ""], first.length);
  expect(findUrlAtCell(buffer, { row: 3, col: left + 8 })?.url).toBe(last);
});

test("does not offer an inner URL on the second row of a token cut by a pane merge", () => {
  const inner = "https://inner.test/doc";
  const { buffer, left } = plainPane([
    "S│", "S│", "S│https://one.test/?scope=", "abcdefghijklmnopqrstuvw%20", inner, "",
  ], 26, 0);
  expect(findUrlAtCell(buffer, { row: 4, col: left + inner.indexOf("inner") })).toBeNull();
});

test("does not use a Markdown destination or file URI as evidence for a preceding query", () => {
  const first = "https://one.test/search?q=ready", web = "https://b.test/a%20b?n=1";
  for (const [printed, hit, url] of [
    [`[go](${web})`, "b.test", web],
    ["file:///tmp/a%20b", "a%20b", null],
  ] as const) {
    const { buffer, left } = plainPane(["", first, printed, ""], first.length);
    const point = { row: 2, col: left + printed.indexOf(hit) };
    expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(first);
    expect(findUrlAtCell(buffer, point)?.url ?? null).toBe(url);
    if (url === null) expect(findPathAtCell(buffer, point)?.path).toBe("/tmp/a b");
  }
});

test("keeps an unused column before a URL that spans the entire unpadded pane", () => {
  const first = "https://one.test/?return_to=", second = "https://two.test/cb&state=yes";
  const { buffer, left } = plainPane(["", first, second, ""], 29, 0);
  expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(first);
  expect(findUrlAtCell(buffer, { row: 2, col: left + 8 })?.url).toBe(second);
});

test("a comma after an ambiguous pair separates the third direct URL", () => {
  const first = "https://one.test/path/", last = "https://three.test/";
  const { buffer, left } = plainPane(["", first, "https://two.test/path,", last, ""], 22);
  for (const row of [1, 2]) expect(findUrlAtCell(buffer, { row, col: left + 8 })).toBeNull();
  expect(findUrlAtCell(buffer, { row: 3, col: left + 8 })?.url).toBe(last);
});

test("recognizes a spare content column even when earlier text exhausts the backward scan", () => {
  const url = "https://three.test/";
  const lines = [...Array(32).fill("x".repeat(24)), "x".repeat(23), url];
  const { buffer, left } = plainPane(lines, 24);
  expect(findUrlAtCell(buffer, { row: lines.length - 1, col: left + 8 })?.url).toBe(url);
});

test("a parenthesized OSC 8 link beyond a visible gap does not hide the earlier plain URL", () => {
  const first = "https://one.test/path", second = "https://two.test/", explicit = "https://linked.test/";
  const { parser, left } = plainPane(["", first, "", ""], 22);
  parser.write(`\x1b[3;${left + 1}H(\x1b]8;;${explicit}\x07${second}\x1b]8;;\x07)`);
  const buffer = parser.getFullBuffer();
  expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(first);
  expect(findUrlAtCell(buffer, { row: 2, col: left + 9 })?.url).toBe(explicit);
});

test("a split redirect host and port stay inside the outer query", () => {
  const parts = ["https://one.test/?scope=", "x&redirect=http://abcdef", "gh.test:8080/cb&state=ok"];
  const { buffer, left } = plainPane(["", ...parts, ""], parts[0].length);
  for (const row of [1, 2, 3]) {
    expect(findUrlAtCell(buffer, { row, col: left + 6 })?.url).toBe(parts.join(""));
  }
});

test("a visible parenthesis ends the target before an independent status or URL", () => {
  const first = "https://one.test/?x=y", second = "https://two.test/doc";
  for (const [label, space, next] of [["See", "", "Done"], ["Open", "", second], ["Open", " ", second]]) {
    const printed = `${label} (${space}${first})`;
    const { buffer, left } = plainPane(["", printed, next, ""], printed.length);
    if (label === "Open") {
      for (const cell of buffer[1].slice(left, left + label.length)) cell.style = { ...DEFAULT_STYLE, underline: true };
      expect(findUrlAtCell(buffer, { row: 1, col: left + 1 })?.url).toBe(first);
    }
    expect(findUrlAtCell(buffer, { row: 1, col: left + printed.indexOf("one") })?.url).toBe(first);
    expect(findUrlAtCell(buffer, { row: 2, col: left + 1 })?.url ?? null).toBe(next === second ? second : null);
  }
});

test("an inner closing parenthesis cannot reveal another host in a clipped soft-wrapped URL", () => {
  const parser = new AnsiParser(40, 44), prefix = "https://outer.test/".padEnd(1600, "x");
  const suffix = "p(https://a.test/)https://b.test/";
  parser.write(prefix + suffix);
  const offset = prefix.length + suffix.indexOf("b.test");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: Math.floor(offset / 40), col: offset % 40 })).toBeNull();
});

test("a status label ending in a colon does not disable the preceding independent URL", () => {
  const url = "https://one.test/report";
  const { buffer, left } = plainPane(["", url, "Status: done", ""], url.length);
  expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(url);
  expect(findUrlAtCell(buffer, { row: 2, col: left + 1 })).toBeNull();
});

test("a visible spare column after a clipped parenthesized log token starts a new link", () => {
  const url = "https://three.test/", width = 24;
  const lines = [...Array(32).fill("x".repeat(width)), "log(https://one.test/a)", url];
  const { buffer, left } = plainPane(lines, width);
  expect(findUrlAtCell(buffer, { row: lines.length - 1, col: left + 8 })?.url).toBe(url);
});

test("preserves a visible quote as a token separator on a proven soft wrap", () => {
  const url = "https://one.test/", parser = new AnsiParser(24, 3);
  parser.write("x".repeat(24) + `"${url}"`);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 6 })?.url).toBe(url);
});

test("does not attach a one-word status to a URL at or one column short of the pane edge", () => {
  const url = "https://example.test/report";
  for (const width of [url.length, url.length + 1]) {
    const { buffer, left } = plainPane(["", url, "Done", ""], width);
    expect(findUrlAtCell(buffer, { row: 1, col: left + 8 })?.url).toBe(url);
    expect(findUrlAtCell(buffer, { row: 2, col: left })).toBeNull();
  }
});

const paneQueryRows = [
  "https://example.test/auth?scope=",
  "read%20write&client_id=sample-id",
  "&state=ok",
];

test("includes the last query parameter but not the prose following it on the final pane row", () => {
  const [first, middle, last] = paneQueryRows;
  const { buffer, left } = plainPane(["", first, middle, `${last} done`, ""], first.length);
  for (const [index, chunk] of paneQueryRows.entries()) {
    const row = index + 1, endCol = left + chunk.length - 1;
    for (const col of [left, endCol]) {
      expect(findUrlAtCell(buffer, { row, col })).toEqual({ url: first + middle + last, startCol: left, endCol });
    }
  }
  expect(findUrlAtCell(buffer, { row: 3, col: left + last.length + 1 })).toBeNull();
});

test("does not charge 31 full rows of multiword logs against the following independent links", () => {
  const first = "https://one.test/status", second = "https://two.test/doc";
  const logs = Array(31).fill("INFO finished job ".padEnd(first.length, "0"));
  const { buffer, left } = plainPane([...logs, first, second], first.length);
  for (const [index, url] of [first, second].entries()) {
    expect(findUrlAtCell(buffer, { row: logs.length + index, col: left + 8 })?.url).toBe(url);
  }
});

test("does not offer a partial target when the final query row loses a pane divider", () => {
  for (const [divider, replacement] of [["│", "├"], ["▕", " "]]) {
    const { parser, buffer, left } = plainPane(["", ...paneQueryRows, ""], paneQueryRows[0].length);
    const col = buffer[3].findIndex(cell => cell.char === divider);
    parser.write(`\x1b[4;${col + 1}H${replacement}`);
    for (const row of [1, 2, 3]) {
      expect(findUrlAtCell(parser.getFullBuffer(), { row, col: left + 3 })).toBeNull();
    }
  }
});

test("rejects surviving URL cells after alternate-screen narrowing until the clipped frame is repainted", () => {
  const lines = ["", ...paneQueryRows, ""], width = paneQueryRows[0].length;
  const { parser, left } = plainPane(lines, width);
  const cols = left + width - 4;
  parser.resize(cols, lines.length); // Crops visible characters from both full URL rows.
  for (const row of [1, 2, 3]) {
    expect(findUrlAtCell(parser.getFullBuffer(), { row, col: left + 3 })).toBeNull();
  }
  parser.write(`\x1b[2;${left + 1}Hhttps://`);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: left + 3 })).toBeNull();

  const fresh = "https://fresh.test/redrawn";
  for (let row = 0; row < lines.length; row++) {
    parser.write(`\x1b[${row + 1};1H${(row === 1 ? fresh : "").padEnd(cols)}`);
  }
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 8 })?.url).toBe(fresh);
});

test("never substitutes an embedded URI when a plain pane URL exceeds the scan budget", () => {
  for (const [width, rowsBeforeInner, fullRows] of [[40, 18, 40], [200, 22, 26]]) {
    const prefix = "https://example.test/?scope=".padEnd(width * rowsBeforeInner - 3, "x") + "%20";
    const url = (prefix + "https://inner.test/resource/").padEnd(width * fullRows + 8, "y");
    const chunks = url.match(new RegExp(`.{1,${width}}`, "g"))!;
    const { buffer, left } = plainPane(["", ...chunks, ""], width);
    for (const row of [1, rowsBeforeInner + 1, chunks.length]) {
      expect(findUrlAtCell(buffer, { row, col: left + 3 })).toBeNull();
    }
  }
});

test("does not offer a partial plain pane link across concealed content or an OSC 8 margin", () => {
  const chunks = paneQueryRows, width = chunks[0].length;
  for (const [offset, hidden] of [[5, true], [-1, false], [width, true], [width, false]] as const) {
    const { buffer, left } = plainPane(["", ...chunks, ""], width);
    expect(findUrlAtCell(buffer, { row: 2, col: left + 3 })?.url).toBe(chunks.join(""));
    const col = left + offset;
    const cell = buffer[2][col];
    buffer[2][col] = hidden ? { ...cell, style: { ...cell.style, hidden: true } } :
      { ...cell, hyperlink: { uri: "https://other.test/" } };
    for (const row of [1, chunks.length]) {
      expect(findUrlAtCell(buffer, { row, col: left + 3 })).toBeNull();
    }
  }
});

test("joins actual soft-wrapped URLs without dropping query parameters", () => {
  const parser = new AnsiParser(80, 12);
  parser.write(`(${oauthUrl})`);
  for (let row = 0; row < Math.ceil((oauthUrl.length + 2) / 80); row++) {
    expect(findUrlAtCell(parser.getFullBuffer(), { row, col: 5 })?.url).toBe(oauthUrl);
  }
});

test("rejects concealed or explicit-link cells anywhere in a rendered URL or its margins", () => {
  for (const [row, col, kind] of [
    [2, 24, "hidden"], [2, 18, "hidden"], [1, "trailing", "hyperlink"], [2, 19, "hyperlink"],
  ] as const) {
    const { parser, width } = renderedOAuth();
    const cells = parser.getFullBuffer().map(row => row.map(cell => ({ ...cell })));
    const cell = cells[row][col === "trailing" ? width + 20 : col];
    if (kind === "hidden") cell.style = { ...cell.style, hidden: true };
    else cell.hyperlink = { uri: "https://different.example/" };
    expect(findUrlAtCell(cells, { row: 0, col: 22 })).toBeNull();
    expect(findUrlAtCell(cells, { row: 1, col: 22 })).toBeNull();
  }
});

test("never opens a surviving URL prefix after partial pane erasure or snapshot restoration", () => {
  const { parser, width } = renderedOAuth();
  parser.write(`\x1b[3;20H\x1b[${width}X`);
  for (const row of [0, 1, 3]) {
    expect(findUrlAtCell(parser.getFullBuffer(), { row, col: 22 })).toBeNull();
  }
  const source = new AnsiParser(80, 12);
  source.write(`(${oauthUrl})`);
  const restored = new AnsiParser(80, 12);
  restored.restoreSnapshot(source.createSnapshot());
  expect(findUrlAtCell(restored.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
});

test("keeps balanced URL parentheses but stops at the rendered target's closing delimiter", () => {
  const parser = new AnsiParser(40, 5);
  const url = "https://example.com/a_(b)?q=kept";
  parser.write(`(${url})${"x".repeat(80)}`);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })?.url).toBe(url);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 8 })).toBeNull();
});

test("does not open a bounded scan's truncated URL or an unsafe rendered label target", () => {
  const parser = new AnsiParser(80, 70);
  parser.write(`https://example.com/${"a".repeat(5000)}`);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
  for (const target of ["javascript:alert(1)", "https://trusted.example@evil.example/"]) {
    const label = new AnsiParser(100, 3);
    label.write(`\x1b[4mOpen link\x1b[0m (${target})`);
    expect(findUrlAtCell(label.getFullBuffer(), { row: 0, col: 3 })).toBeNull();
  }
});

test("rejects a surviving prefix when its soft-wrap successor is erased in place", () => {
  const parser = new AnsiParser(40, 3);
  parser.write("https://example.com/" + "a".repeat(30));
  parser.write("\r\x1b[K");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
});

test("does not use a hidden or OSC 8 closing delimiter to shorten a rendered URL", () => {
  for (const delimiter of [
    "\x1b[8m)\x1b[28m",
    "\x1b]8;;https://other.example/\x1b\\)\x1b]8;;\x1b\\",
  ]) {
    const parser = new AnsiParser(100, 3);
    parser.write(`\x1b[4mSign in\x1b[0m (https://example.com/a${delimiter}?token=kept)`);
    for (const col of [2, 18]) {
      expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col })).toBeNull();
    }
  }
});

test("rejects targets beyond the row or cell scan budget instead of offering a fragment", () => {
  const manyRows = new AnsiParser(80, 40);
  manyRows.write("https://example.com/" + "a".repeat(2561 - "https://example.com/".length));
  expect(findUrlAtCell(manyRows.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
  const wideRow = new AnsiParser(4200, 2);
  wideRow.write("https://example.com/" + "a".repeat(4100));
  expect(findUrlAtCell(wideRow.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
});

test("preserves URL-terminating whitespace at proven soft wraps", () => {
  const parser = new AnsiParser(19, 3);
  parser.write("https://example.com .evil");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })?.url).toBe("https://example.com/");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 3 })).toBeNull();
});

test("does not spend the target scan budget on preceding wrapped prose", () => {
  const parser = new AnsiParser(20, 40);
  parser.write("x".repeat(640) + "\x1b[4mOpen\x1b[0m (https://example.com/path)");
  for (const point of [{ row: 32, col: 1 }, { row: 32, col: 10 }, { row: 33, col: 3 }]) {
    expect(findUrlAtCell(parser.getFullBuffer(), point)?.url).toBe("https://example.com/path");
  }
});

test("rejects partially erased successors instead of treating missing URI characters as whitespace", () => {
  const parser = new AnsiParser(40, 3);
  parser.write("https://example.com/" + "a".repeat(30));
  parser.write("\x1b[2;1H\x1b[3X");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
});

test("rejects incoming URL cells shifted by character insertion without deleting them", () => {
  const parser = new AnsiParser(40, 3);
  parser.write("https://example.com/" + "a".repeat(30));
  parser.write("\x1b[2;1H\x1b[@");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
});

test("keeps a nested parenthesized URL inside the complete outer wrapped target", () => {
  const url = "https://example.com/a(https://other.example/b)";
  const parser = new AnsiParser(20, 5);
  parser.write(`(${url})`);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 5 })?.url).toBe(url);
});

test("does not let a later independent URL detach the clicked earlier URL's wrapped suffix", () => {
  for (const url of [
    "https://a.test/" + "x".repeat(40 - "https://a.test/".length) + "a(https://b.test/)",
    "https://example.com/" + "a".repeat(30),
  ]) {
    const parser = new AnsiParser(40, 3);
    parser.write(`${url} https://c.test/`);
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 5 })?.url).toBe(url);
  }
});

test("keeps ordinary hard-newline whitespace from changing a URL's host", () => {
  for (const opener of ["", "("]) {
    const parser = new AnsiParser(20 + opener.length, 3);
    parser.write(`${opener}https://example.com \r\n .evil${opener ? ")" : ""}`);
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })?.url).toBe("https://example.com/");
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 3 })).toBeNull();
  }
});

test("keeps erased or shifted incoming URL provenance invalid across resize", () => {
  for (const mutation of ["\x1b[2;4H\x1b[3X", "\x1b[2;1H\x1b[K", "\x1b[2;1H\x1b[@"]) {
    const parser = new AnsiParser(40, 3);
    parser.write("https://example.com/" + "a".repeat(30));
    parser.write(mutation);
    parser.resize(40, 4);
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toBeNull();
  }
});

test("preserves an intact wrapped OAuth URL when narrowing creates several chunks per row", () => {
  const parser = new AnsiParser(100, 6);
  parser.write(`(${oauthUrl})`);
  parser.resize(20, 30);
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })?.url).toBe(oauthUrl);
});

test("keeps independent URLs on either side of an ordinary hard newline clickable", () => {
  const parser = new AnsiParser(20, 4);
  parser.write("https://example.com \r\n https://other.test/");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })?.url).toBe("https://example.com/");
  expect(findUrlAtCell(parser.getFullBuffer(), { row: 1, col: 8 })?.url).toBe("https://other.test/");
});

describe("findUrlAtCell", () => {
  test("returns the full https URL with path, query, hash, and inclusive columns when clicked inside it", () => {
    const url = "https://example.com/docs/page?term=redterm&sort=asc#section-2";
    const text = `open ${url} now`;
    const startCol = text.indexOf(url);

    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: startCol + 12 })).toEqual({
      url,
      startCol,
      endCol: startCol + url.length - 1,
    });
  });

  test("trims prose punctuation from the URL and does not treat those trailing cells as clickable", () => {
    const url = "https://example.com/releases?tag=v1.5.1#notes";
    const text = `see (${url}).`;
    const startCol = text.indexOf(url);
    const endCol = startCol + url.length - 1;

    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: startCol + 8 })).toEqual({
      url,
      startCol,
      endCol,
    });
    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: endCol + 1 })).toBeNull();
    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: endCol + 2 })).toBeNull();
  });

  test("returns null when the clicked cell is outside the URL on the visual row", () => {
    const url = "https://example.com/path";
    const text = `prefix ${url} suffix`;
    const startCol = text.indexOf(url);
    const endCol = startCol + url.length - 1;

    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: startCol - 1 })).toBeNull();
    expect(findUrlAtCell(bufferFromRows(text), { row: 0, col: endCol + 1 })).toBeNull();
    expect(findUrlAtCell(bufferFromRows(text, "same column has no link"), { row: 1, col: startCol + 4 })).toBeNull();
  });

  test("ignores ftp and javascript schemes", () => {
    for (const { text, col } of [
      { text: "download ftp://example.com/archive.tar.gz", col: "download ftp://".length + 4 },
      { text: "run javascript:alert(1)", col: "run javascript:".length + 1 },
    ]) {
      expect(findUrlAtCell(bufferFromRows(text), { row: 0, col })).toBeNull();
    }
  });
  test("returns null for a row-ending URL candidate when the next row continues with URL-safe text", () => {
    const firstRow = "https://example.com/very-";
    const buffer = bufferFromRows(firstRow, "long/path");

    expect(findUrlAtCell(buffer, { row: 0, col: firstRow.indexOf("example") })).toBeNull();
  });

  test("returns null for a row-ending URL candidate when trimmed punctuation hides a continuation", () => {
    const firstRow = "https://example.com/search?";
    const buffer = bufferFromRows(firstRow, "q=red");

    expect(findUrlAtCell(buffer, { row: 0, col: firstRow.indexOf("example") })).toBeNull();
  });


  test("does not make URLs with hidden cells clickable", () => {
    const url = "https://example.com/path";
    const buffer = bufferFromRows(url);
    buffer[0]["https://".length + 2].style = { ...DEFAULT_STYLE, hidden: true };

    expect(findUrlAtCell(buffer, { row: 0, col: 10 })).toBeNull();
  });
  test("uses an OSC 8 hyperlink across its contiguous cell range", () => {
    const buffer = bufferFromRows("click plain");
    for (let col = 0; col < 5; col++) {
      buffer[0][col].hyperlink = { uri: "https://example.com/docs", id: "docs" };
    }

    expect(findUrlAtCell(buffer, { row: 0, col: 2 })).toEqual({
      url: "https://example.com/docs",
      startCol: 0,
      endCol: 4,
    });
    expect(findUrlAtCell(buffer, { row: 0, col: 6 })).toBeNull();
    buffer[0][0].hyperlink = { uri: "javascript:alert(1)" };
    expect(findUrlAtCell(buffer, { row: 0, col: 0 })).toBeNull();
  });

  test("maps UTF-16 match offsets back to terminal cell columns", () => {
    const url = "https://example.com";
    const buffer = bufferFromRows(`😀${url}`);

    expect(findUrlAtCell(buffer, { row: 0, col: 1 })).toEqual({
      url: "https://example.com/",
      startCol: 1,
      endCol: url.length,
    });
    expect(findUrlAtCell(buffer, { row: 0, col: url.length + 1 })).toBeNull();
  });
  test("keeps wide characters and their continuation cells inside one URL", () => {
    const parser = new AnsiParser(80, 3);
    const url = "https://example.com/경로";
    parser.write(url);
    const endCol = "https://example.com/".length + 3;

    const expected = {
      url: new URL(url).href,
      startCol: 0,
      endCol,
    };
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: 8 })).toEqual(expected);
    expect(findUrlAtCell(parser.getFullBuffer(), { row: 0, col: endCol })).toEqual(expected);
  });


});

describe("validateTerminalUrl", () => {
  test("normalizes safe HTTP origins for confirmation and opening", () => {
    expect(validateTerminalUrl("HTTPS://EXAMPLE.COM:443/path?q=1")).toEqual({
      url: "https://example.com/path?q=1",
      origin: "example.com",
    });
    expect(validateTerminalUrl("http://example.com:8080/")).toEqual({
      url: "http://example.com:8080/",
      origin: "example.com:8080",
    });
  });

  test("rejects userinfo and bidirectional control characters", () => {
    expect(validateTerminalUrl("https://trusted.example@evil.example/")).toBeNull();
    expect(validateTerminalUrl("https://evil.example/\u202etrusted.example")).toBeNull();
  });
});
