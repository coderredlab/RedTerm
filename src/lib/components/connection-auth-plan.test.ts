// @ts-nocheck
import { describe, expect, test } from "bun:test";

import type { SavedConnection } from "../tauri/commands";
import * as connectionAuthPlan from "./connection-auth-plan";
const { buildConnectionAuthConfig, shouldPromptForKeyPassphraseRetry } = connectionAuthPlan;

describe("connection auth planning", () => {
  test("omits the key passphrase field when the entered passphrase is empty", () => {
    const auth = buildConnectionAuthConfig({
      authType: "key",
      username: "deploy",
      keyPath: "/home/deploy/.ssh/id_ed25519",
      passphrase: "",
    });

    expect(auth).toEqual({
      username: "deploy",
      method: { type: "key", key_path: "/home/deploy/.ssh/id_ed25519" },
    });
    expect(Object.hasOwn(auth.method, "passphrase")).toBe(false);
  });

  test("omits a blank dialog key passphrase from backend auth", () => {
    const plan = connectionAuthPlan.buildConnectionAuthPlan({
      authType: "key",
      username: "deploy",
      keyPath: "/home/deploy/.ssh/id_ed25519",
      passphrase: "",
    });

    expect(plan.auth).toEqual({
      username: "deploy",
      method: { type: "key", key_path: "/home/deploy/.ssh/id_ed25519" },
    });
    expect(Object.hasOwn(plan.auth.method, "passphrase")).toBe(false);
  });

  test("keeps a non-empty key passphrase in auth", () => {
    const passphrase = "  keep surrounding whitespace\t";

    const plan = connectionAuthPlan.buildConnectionAuthPlan({
      authType: "key",
      username: "deploy",
      keyPath: "/home/deploy/.ssh/id_ed25519",
      passphrase,
    });

    expect(plan.auth).toEqual({
      username: "deploy",
      method: {
        type: "key",
        key_path: "/home/deploy/.ssh/id_ed25519",
        passphrase,
      },
    });
  });

  test("keeps password auth payloads unchanged", () => {
    const auth = buildConnectionAuthConfig({
      authType: "password",
      username: "deploy",
      password: "p@ss word",
    });

    expect(auth).toEqual({
      username: "deploy",
      method: { type: "password", password: "p@ss word" },
    });
  });

  test("lets a saved key quick-connect passphrase feed auth without persisting onto the saved connection", () => {
    const savedConnection = {
      id: "conn-key-only",
      name: "Key host",
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      key_path: "/persisted/keys/id_ed25519",
      has_saved_password: false,
      use_keyboard_interactive: false,
    } satisfies SavedConnection;
    const originalSavedConnection = { ...savedConnection };

    const auth = buildConnectionAuthConfig({
      authType: "key",
      username: savedConnection.username,
      keyPath: savedConnection.key_path,
      passphrase: "entered only for this connect",
    });

    expect(auth).toEqual({
      username: "deploy",
      method: {
        type: "key",
        key_path: "/persisted/keys/id_ed25519",
        passphrase: "entered only for this connect",
      },
    });
    expect(savedConnection).toEqual(originalSavedConnection);
    expect(Object.hasOwn(savedConnection, "passphrase")).toBe(false);
  });
});

describe("key passphrase retry planning", () => {
  const encryptedKeyAuth = {
    username: "deploy",
    method: { type: "key", key_path: "/home/deploy/.ssh/id_ed25519" },
  };

  test("prompts when unknown key auth fails because the private key is encrypted", () => {
    const encryptedKeyErrors = [
      "Failed to load private key: The key is encrypted",
      "Key error: The key is encrypted",
    ];

    for (const message of encryptedKeyErrors) {
      expect(
        shouldPromptForKeyPassphraseRetry({
          auth: encryptedKeyAuth,
          resolvedKeyPassphrase: undefined,
          error: new Error(message),
        })
      ).toBe(true);
    }
  });

  test("ignores stale explicit-empty metadata when encrypted key auth needs a passphrase", () => {
    const staleRuntimePayload = {
      auth: encryptedKeyAuth,
      resolvedKeyPassphrase: undefined,
      error: new Error("Key error: The key is encrypted"),
      keyPassphraseExplicitEmpty: true,
    } as Parameters<typeof shouldPromptForKeyPassphraseRetry>[0] & {
      keyPassphraseExplicitEmpty: true;
    };

    expect(shouldPromptForKeyPassphraseRetry(staleRuntimePayload)).toBe(true);
  });

  test("does not prompt when auth already includes a non-empty key passphrase", () => {
    expect(
      shouldPromptForKeyPassphraseRetry({
        auth: {
          username: "deploy",
          method: {
            type: "key",
            key_path: "/home/deploy/.ssh/id_ed25519",
            passphrase: "already-entered",
          },
        },
        resolvedKeyPassphrase: undefined,
        error: new Error("Key error: The key is encrypted"),
      })
    ).toBe(false);
  });

  test("does not prompt when a key passphrase was already resolved for this tab", () => {
    for (const resolvedKeyPassphrase of ["", "resolved-from-previous-prompt"]) {
      expect(
        shouldPromptForKeyPassphraseRetry({
          auth: encryptedKeyAuth,
          resolvedKeyPassphrase,
          error: new Error("Key error: The key is encrypted"),
        })
      ).toBe(false);
    }
  });

  test("does not prompt for unrelated key authentication errors", () => {
    expect(
      shouldPromptForKeyPassphraseRetry({
        auth: encryptedKeyAuth,
        resolvedKeyPassphrase: undefined,
        error: new Error("Permission denied (publickey)"),
      })
    ).toBe(false);
  });
});

describe("key passphrase retry cache", () => {
  const encryptedKeyAuth = {
    username: "deploy",
    method: { type: "key", key_path: "/home/deploy/.ssh/id_ed25519" },
  };

  test("keeps a prompted passphrase staged until retry connect succeeds and rolls it back after failure", () => {
    const initialState = connectionAuthPlan.createKeyPassphraseRetryCache();

    const stagedState = connectionAuthPlan.stageKeyPassphraseRetry(initialState, "wrong-passphrase");

    expect(connectionAuthPlan.getResolvedKeyPassphrase(stagedState)).toBeUndefined();
    expect(
      buildConnectionAuthConfig({
        authType: "key",
        username: encryptedKeyAuth.username,
        keyPath: encryptedKeyAuth.method.key_path,
        passphrase: connectionAuthPlan.getKeyPassphraseForConnect(stagedState),
      })
    ).toEqual({
      username: "deploy",
      method: {
        type: "key",
        key_path: "/home/deploy/.ssh/id_ed25519",
        passphrase: "wrong-passphrase",
      },
    });

    const rolledBackState = connectionAuthPlan.rollbackKeyPassphraseRetry(stagedState);

    expect(connectionAuthPlan.getKeyPassphraseForConnect(rolledBackState)).toBeUndefined();
    expect(
      shouldPromptForKeyPassphraseRetry({
        auth: encryptedKeyAuth,
        resolvedKeyPassphrase: connectionAuthPlan.getResolvedKeyPassphrase(rolledBackState),
        error: new Error("Key error: The key is encrypted"),
      })
    ).toBe(true);

    const committedState = connectionAuthPlan.commitKeyPassphraseRetry(stagedState);

    expect(connectionAuthPlan.getResolvedKeyPassphrase(committedState)).toBe("wrong-passphrase");
    expect(connectionAuthPlan.getKeyPassphraseForConnect(committedState)).toBe("wrong-passphrase");
  });
});
