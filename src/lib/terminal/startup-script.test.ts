// @ts-nocheck
import { describe, expect, test } from "bun:test";

import { buildStartupScriptPayload, createStartupScriptDispatcher } from "./startup-script";

describe("startup script payload normalization", () => {
  test("returns null for absent or blank-only scripts", () => {
    for (const script of [undefined, null, "", "   ", "\t\n\r\n  "]) {
      expect(buildStartupScriptPayload(script)).toBeNull();
    }
  });

  test("appends exactly one final Enter to a single command", () => {
    expect(buildStartupScriptPayload("uname -a")).toBe("uname -a\r");
    expect(buildStartupScriptPayload("uname -a\n")).toBe("uname -a\r");
  });

  test("normalizes CRLF and CR line endings to Enter bytes", () => {
    expect(buildStartupScriptPayload("echo one\r\necho two\recho three")).toBe(
      "echo one\recho two\recho three\r"
    );
  });

  test("preserves internal blank lines and command content while trimming trailing whitespace-only lines", () => {
    const script = "echo one\n\n  \necho two   \n\t\n  \n";

    expect(buildStartupScriptPayload(script)).toBe("echo one\r\r  \recho two   \r");
  });
});

describe("startup script readiness gating", () => {
  test("sends immediately when ready text is absent or blank", () => {
    for (const readyText of [undefined, null, "", "   ", "\t\n  "]) {
      const dispatcher = createStartupScriptDispatcher("whoami\n", readyText);

      expect(dispatcher.takeImmediatePayload()).toBe("whoami\r");
      expect(dispatcher.takeImmediatePayload()).toBeNull();
      expect(dispatcher.consumeOutput("whoami\n")).toBeNull();
    }
  });

  test("waits for nonblank ready text before sending the script once", () => {
    const dispatcher = createStartupScriptDispatcher("echo ready\n", "$ ");

    expect(dispatcher.takeImmediatePayload()).toBeNull();
    expect(dispatcher.consumeOutput("login: redterm\n")).toBeNull();
    expect(dispatcher.consumeOutput("last login\n$ ")).toBe("echo ready\r");
    expect(dispatcher.consumeOutput("$ ")).toBeNull();
    expect(dispatcher.takeImmediatePayload()).toBeNull();
  });

  test("matches ready text against visible prompt text when ANSI styling is present", () => {
    const dispatcher = createStartupScriptDispatcher("echo ansi-ready\n", "user@host:~$");
    const coloredPrompt = "\x1b[01;32muser@host\x1b[0m:\x1b[01;34m~\x1b[0m$";

    expect(dispatcher.takeImmediatePayload()).toBeNull();
    expect(dispatcher.consumeOutput(`last login\n${coloredPrompt}`)).toBe("echo ansi-ready\r");
    expect(dispatcher.consumeOutput(coloredPrompt)).toBeNull();
  });

  test("continues consuming chunks until ready text appears", () => {
    const dispatcher = createStartupScriptDispatcher("printf done\r\n", "READY>");

    expect(dispatcher.consumeOutput("booting\n")).toBeNull();
    expect(dispatcher.consumeOutput("still loading\n")).toBeNull();
    expect(dispatcher.consumeOutput("READY>")).toBe("printf done\r");
    expect(dispatcher.consumeOutput("READY>")).toBeNull();
  });

  test("detects ready text split across output chunks", () => {
    const dispatcher = createStartupScriptDispatcher("stty -echo\n", "shell-ready");

    expect(dispatcher.consumeOutput("shell-")).toBeNull();
    expect(dispatcher.consumeOutput("ready")).toBe("stty -echo\r");
    expect(dispatcher.consumeOutput("shell-ready")).toBeNull();
  });
});
