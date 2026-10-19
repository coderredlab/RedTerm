// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { AnsiParser, DEFAULT_STYLE, type Cell } from "./ansi-parser";
import { findUrlAtCell, validateTerminalUrl } from "./terminal-links";

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
