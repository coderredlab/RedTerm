import type { AuthConfig } from "../tauri/commands";

type ConnectionAuthPlanInput =
  | {
      authType: "password";
      username: string;
      password: string;
    }
  | {
      authType: "storedPassword";
      username: string;
      connectionId: string;
    }
  | {
      authType: "key";
      username: string;
      keyId: string;
      passphrase?: string;
    };

export function buildConnectionAuthConfig(input: ConnectionAuthPlanInput): AuthConfig {
  if (input.authType === "password") {
    return {
      username: input.username,
      method: { type: "password", password: input.password },
    };
  }
  if (input.authType === "storedPassword") {
    return {
      username: input.username,
      method: { type: "stored_password", connection_id: input.connectionId },
    };
  }
  const method: AuthConfig["method"] = {
    type: "key",
    key_id: input.keyId,
  };
  if (input.passphrase && input.passphrase.length > 0) {
    method.passphrase = input.passphrase;
  }

  return {
    username: input.username,
    method,
  };
}

export interface ConnectionAuthPlan {
  auth: AuthConfig;
}

export function buildConnectionAuthPlan(input: ConnectionAuthPlanInput): ConnectionAuthPlan {
  return {
    auth: buildConnectionAuthConfig(input),
  };
}

export interface KeyPassphraseRetryCache {
  resolvedKeyPassphrase?: string;
  stagedKeyPassphrase?: string;
}

export function createKeyPassphraseRetryCache(resolvedKeyPassphrase?: string): KeyPassphraseRetryCache {
  return resolvedKeyPassphrase === undefined ? {} : { resolvedKeyPassphrase };
}

export function getResolvedKeyPassphrase(cache: KeyPassphraseRetryCache): string | undefined {
  return cache.resolvedKeyPassphrase;
}

export function getKeyPassphraseForConnect(cache: KeyPassphraseRetryCache): string | undefined {
  return cache.stagedKeyPassphrase ?? cache.resolvedKeyPassphrase;
}

export function stageKeyPassphraseRetry(
  cache: KeyPassphraseRetryCache,
  passphrase: string
): KeyPassphraseRetryCache {
  return {
    resolvedKeyPassphrase: cache.resolvedKeyPassphrase,
    stagedKeyPassphrase: passphrase,
  };
}

export function commitKeyPassphraseRetry(cache: KeyPassphraseRetryCache): KeyPassphraseRetryCache {
  const resolvedKeyPassphrase = cache.stagedKeyPassphrase ?? cache.resolvedKeyPassphrase;
  return createKeyPassphraseRetryCache(resolvedKeyPassphrase);
}

export function rollbackKeyPassphraseRetry(cache: KeyPassphraseRetryCache): KeyPassphraseRetryCache {
  return createKeyPassphraseRetryCache(cache.resolvedKeyPassphrase);
}

export interface KeyPassphraseRetryInput {
  auth: AuthConfig;
  resolvedKeyPassphrase?: string;
  error: unknown;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shouldPromptForKeyPassphraseRetry(input: KeyPassphraseRetryInput): boolean {
  if (input.auth.method.type !== "key") return false;
  if (input.auth.method.passphrase && input.auth.method.passphrase.length > 0) return false;
  if (input.resolvedKeyPassphrase !== undefined) return false;

  return getErrorMessage(input.error).includes("The key is encrypted");
}
