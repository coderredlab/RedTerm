// @ts-nocheck
import { describe, expect, test } from "bun:test";

import {
  runHostKeyGate,
  type HostKeyPreflightResult,
  type HostKeyPromptChallenge,
  type HostKeyPromptDecision,
  type HostKeyTrustRequest,
} from "./host-key-gate";

const target = { host: "bastion.example.com", port: 2222 };
const presentedKey = {
  algorithm: "ssh-ed25519",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMhTestPresentedKey redterm-test",
  fingerprint: "SHA256:presented-key-fingerprint",
  challengeToken: "challenge-presented-key",
};

function unknownPreflight(): HostKeyPreflightResult {
  return { status: "unknown", ...presentedKey };
}

function changedPreflight(status: "changed" | "conflict"): HostKeyPreflightResult {
  return {
    status,
    ...presentedKey,
    knownFingerprints: ["SHA256:previously-trusted-key"],
  };
}

describe("host key gate planning", () => {
  test("trusted preflight proceeds to connect without prompting or writing trust", async () => {
    const preflights: Array<typeof target> = [];
    const prompts: HostKeyPromptChallenge[] = [];
    const trustWrites: HostKeyTrustRequest[] = [];
    const connects: string[] = [];

    const result = await runHostKeyGate({
      target,
      preflightHostKey: async (host, port) => {
        preflights.push({ host, port });
        return { status: "trusted" } satisfies HostKeyPreflightResult;
      },
      promptHostKey: async (challenge) => {
        prompts.push(challenge);
        return "cancel" satisfies HostKeyPromptDecision;
      },
      trustHostKey: async (request) => {
        trustWrites.push(request);
      },
      connect: async () => {
        connects.push("connect");
        return "session-trusted";
      },
    });

    expect(result).toEqual({ status: "connected", sessionId: "session-trusted" });
    expect(preflights).toEqual([target]);
    expect(prompts).toEqual([]);
    expect(trustWrites).toEqual([]);
    expect(connects).toEqual(["connect"]);
  });

  test("unknown preflight waits for approval, trusts the presented key exactly, then connects", async () => {
    const promptStarted = Promise.withResolvers<void>();
    const promptDecision = Promise.withResolvers<HostKeyPromptDecision>();
    const prompts: HostKeyPromptChallenge[] = [];
    const trustWrites: HostKeyTrustRequest[] = [];
    const connects: string[] = [];

    const resultPromise = runHostKeyGate({
      target,
      preflightHostKey: async () => unknownPreflight(),
      promptHostKey: async (challenge) => {
        prompts.push(challenge);
        promptStarted.resolve();
        return promptDecision.promise;
      },
      trustHostKey: async (request) => {
        trustWrites.push(request);
      },
      connect: async () => {
        connects.push("connect");
        return "session-approved";
      },
    });

    await promptStarted.promise;

    expect(prompts).toEqual([{ kind: "unknown", host: target.host, port: target.port, ...presentedKey }]);
    expect(trustWrites).toEqual([]);
    expect(connects).toEqual([]);

    promptDecision.resolve("trust");

    await expect(resultPromise).resolves.toEqual({ status: "connected", sessionId: "session-approved" });
    expect(trustWrites).toEqual([{ challengeToken: presentedKey.challengeToken }]);
    expect(connects).toEqual(["connect"]);
  });

  test("approved unknown preflight clears the prompt after trust before connecting", async () => {
    const events: string[] = [];
    let pendingHostKeyPrompt: HostKeyPromptChallenge | null = null;
    let connectSawPromptCleared = false;

    const result = await runHostKeyGate({
      target,
      preflightHostKey: async () => unknownPreflight(),
      promptHostKey: async (challenge) => {
        pendingHostKeyPrompt = challenge;
        return "trust";
      },
      trustHostKey: async () => {
        events.push("trust");
      },
      clearTrustedHostKeyPrompt: () => {
        events.push("clear");
        pendingHostKeyPrompt = null;
      },
      connect: async () => {
        events.push("connect");
        connectSawPromptCleared = pendingHostKeyPrompt === null;
        return "session-after-clear";
      },
    });

    expect(result).toEqual({ status: "connected", sessionId: "session-after-clear" });
    expect(events).toEqual(["trust", "clear", "connect"]);
    expect(connectSawPromptCleared).toBe(true);
  });


  test("changed and conflict preflights use a stronger prompt kind and do not auto-connect", async () => {
    for (const status of ["changed", "conflict"] as const) {
      const promptStarted = Promise.withResolvers<void>();
      const promptDecision = Promise.withResolvers<HostKeyPromptDecision>();
      const prompts: HostKeyPromptChallenge[] = [];
      const trustWrites: HostKeyTrustRequest[] = [];
      const connects: string[] = [];

      const resultPromise = runHostKeyGate({
        target,
        preflightHostKey: async () => changedPreflight(status),
        promptHostKey: async (challenge) => {
          prompts.push(challenge);
          promptStarted.resolve();
          return promptDecision.promise;
        },
        trustHostKey: async (request) => {
          trustWrites.push(request);
        },
        connect: async () => {
          connects.push("connect");
          return `session-${status}`;
        },
      });

      await promptStarted.promise;

      expect(prompts).toEqual([
        {
          kind: "changed",
          host: target.host,
          port: target.port,
          ...presentedKey,
          knownFingerprints: ["SHA256:previously-trusted-key"],
        },
      ]);
      expect(trustWrites).toEqual([]);
      expect(connects).toEqual([]);

      promptDecision.resolve("cancel");

      await expect(resultPromise).resolves.toEqual({ status: "blocked", reason: "cancelled" });
      expect(trustWrites).toEqual([]);
      expect(connects).toEqual([]);
    }
  });

  test("changed and conflict prompts trust the presented key exactly before connecting", async () => {
    for (const status of ["changed", "conflict"] as const) {
      const promptStarted = Promise.withResolvers<void>();
      const promptDecision = Promise.withResolvers<HostKeyPromptDecision>();
      const trustStarted = Promise.withResolvers<void>();
      const trustAllowed = Promise.withResolvers<void>();
      const preflight = {
        status,
        algorithm: "ssh-ed25519",
        publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIChangedApproval${status} redterm-test`,
        fingerprint: `SHA256:${status}-presented-key-fingerprint`,
        knownFingerprints: [`SHA256:${status}-previously-trusted-key`],
        challengeToken: `challenge-${status}`,
      } satisfies HostKeyPreflightResult;
      const prompts: HostKeyPromptChallenge[] = [];
      const trustWrites: HostKeyTrustRequest[] = [];
      const connects: string[] = [];
      const events: string[] = [];

      const resultPromise = runHostKeyGate({
        target,
        preflightHostKey: async () => preflight,
        promptHostKey: async (challenge) => {
          prompts.push(challenge);
          promptStarted.resolve();
          return promptDecision.promise;
        },
        trustHostKey: async (request) => {
          events.push("trust");
          trustWrites.push(request);
          trustStarted.resolve();
          await trustAllowed.promise;
        },
        connect: async () => {
          events.push("connect");
          connects.push(`connect-${status}`);
          return `session-${status}-approved`;
        },
      });

      await promptStarted.promise;

      expect(prompts).toEqual([
        {
          kind: "changed",
          host: target.host,
          port: target.port,
          algorithm: preflight.algorithm,
          publicKey: preflight.publicKey,
          fingerprint: preflight.fingerprint,
          knownFingerprints: preflight.knownFingerprints,
          challengeToken: preflight.challengeToken,
        },
      ]);
      expect(trustWrites).toEqual([]);
      expect(connects).toEqual([]);
      expect(events).toEqual([]);

      promptDecision.resolve("trust");
      await trustStarted.promise;

      expect(trustWrites).toEqual([
        {
          challengeToken: preflight.challengeToken,
        },
      ]);
      expect(connects).toEqual([]);
      expect(events).toEqual(["trust"]);

      trustAllowed.resolve();

      await expect(resultPromise).resolves.toEqual({ status: "connected", sessionId: `session-${status}-approved` });
      expect(connects).toEqual([`connect-${status}`]);
      expect(events).toEqual(["trust", "connect"]);
    }
  });

  test("cancelled unknown prompt does not trust the key or connect", async () => {
    const trustWrites: HostKeyTrustRequest[] = [];
    const connects: string[] = [];

    const result = await runHostKeyGate({
      target,
      preflightHostKey: async () => unknownPreflight(),
      promptHostKey: async () => "cancel",
      trustHostKey: async (request) => {
        trustWrites.push(request);
      },
      connect: async () => {
        connects.push("connect");
        return "session-cancelled";
      },
    });

    expect(result).toEqual({ status: "blocked", reason: "cancelled" });
    expect(trustWrites).toEqual([]);
    expect(connects).toEqual([]);
  });

  test("failed preflight returns a connect-blocking error without prompting or connecting", async () => {
    const prompts: HostKeyPromptChallenge[] = [];
    const trustWrites: HostKeyTrustRequest[] = [];
    const connects: string[] = [];

    const result = await runHostKeyGate({
      target,
      preflightHostKey: async () => {
        throw new Error("host key preflight failed: connection refused");
      },
      promptHostKey: async (challenge) => {
        prompts.push(challenge);
        return "trust";
      },
      trustHostKey: async (request) => {
        trustWrites.push(request);
      },
      connect: async () => {
        connects.push("connect");
        return "session-after-failure";
      },
    });

    expect(result).toEqual({
      status: "blocked",
      reason: "preflight-failed",
      error: "host key preflight failed: connection refused",
    });
    expect(prompts).toEqual([]);
    expect(trustWrites).toEqual([]);
    expect(connects).toEqual([]);
  });
});
