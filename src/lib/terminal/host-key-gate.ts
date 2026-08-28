import { completeHostKeyTrustBeforeConnect } from "./terminal-host-key-flow";

export interface HostKeyTarget {
  host: string;
  port: number;
}

export interface HostKeyTrustedResult {
  status: "trusted";
}

export interface HostKeyChallengeResult {
  status: "unknown" | "changed" | "conflict";
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  knownFingerprints?: string[];
  challengeToken: string;
}

export type HostKeyPreflightResult = HostKeyTrustedResult | HostKeyChallengeResult;

export interface HostKeyPromptChallenge {
  kind: "unknown" | "changed";
  host: string;
  port: number;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  knownFingerprints?: string[];
  challengeToken: string;
}

export type HostKeyPromptDecision = "trust" | "cancel";

export interface HostKeyTrustRequest {
  challengeToken: string;
}

export type HostKeyGateResult =
  | { status: "connected"; sessionId: string }
  | { status: "blocked"; reason: "cancelled" }
  | { status: "blocked"; reason: "preflight-failed"; error: string };

export interface RunHostKeyGateOptions {
  target: HostKeyTarget;
  preflightHostKey: (host: string, port: number) => Promise<HostKeyPreflightResult>;
  promptHostKey: (challenge: HostKeyPromptChallenge) => Promise<HostKeyPromptDecision>;
  trustHostKey: (request: HostKeyTrustRequest) => Promise<void>;
  connect: () => Promise<string>;
  clearTrustedHostKeyPrompt?: () => void | Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPromptChallenge(target: HostKeyTarget, result: HostKeyChallengeResult): HostKeyPromptChallenge {
  return {
    kind: result.status === "unknown" ? "unknown" : "changed",
    host: target.host,
    port: target.port,
    algorithm: result.algorithm,
    publicKey: result.publicKey,
    fingerprint: result.fingerprint,
    knownFingerprints: result.knownFingerprints,
    challengeToken: result.challengeToken,
  };
}

export async function runHostKeyGate(options: RunHostKeyGateOptions): Promise<HostKeyGateResult> {
  let preflight: HostKeyPreflightResult;
  try {
    preflight = await options.preflightHostKey(options.target.host, options.target.port);
  } catch (error) {
    return {
      status: "blocked",
      reason: "preflight-failed",
      error: errorMessage(error),
    };
  }

  if (preflight.status === "trusted") {
    return { status: "connected", sessionId: await options.connect() };
  }

  const challenge = toPromptChallenge(options.target, preflight);
  const decision = await options.promptHostKey(challenge);
  if (decision !== "trust") {
    return { status: "blocked", reason: "cancelled" };
  }

  return {
    status: "connected",
    sessionId: await completeHostKeyTrustBeforeConnect({
      trustHostKey: () =>
        options.trustHostKey({
          challengeToken: preflight.challengeToken,
        }),
      clearHostKeyPrompt: options.clearTrustedHostKeyPrompt ?? (() => {}),
      connect: options.connect,
    }),
  };
}
