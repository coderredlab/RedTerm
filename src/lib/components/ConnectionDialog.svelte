<script lang="ts">
  import { untrack } from "svelte";
  import { connectionsStore } from "$lib/stores/connections.svelte";
  import { tabsStore, type PaneConnection } from "$lib/stores/tabs.svelte";
  import {
    MAX_SSH_KEY_BYTES,
    uploadSshKey,
    type AuthConfig,
    type SavedConnection,
  } from "$lib/tauri/commands";
  import {
    STORED_PASSWORD_PLACEHOLDER,
    buildConnectionDialogSavePlan,
  } from "./connection-dialog-save-plan";
  import { modalFocus } from "$lib/desktop/workspace/modal-focus";
  import {
    cleanupUnreferencedManagedKeys,
    stageManagedKeyCleanup,
  } from "$lib/managed-key-lifecycle";
  import { buildConnectionAuthPlan } from "./connection-auth-plan";

  interface Props {
    open: boolean;
    editConnection?: SavedConnection;
    editPane?: { tabId: string; paneId: string };
    onClose: () => void;
  }

  let { open, editConnection, editPane, onClose }: Props = $props();


  let name = $state("");
  let host = $state("");
  let port = $state(22);
  let username = $state("");
  let password = $state("");
  let keyId = $state("");
  let keyPassphrase = $state("");
  let selectedKeyName = $state("");
  let authType = $state<"password" | "key">("password");
  let activeDialogTab = $state<"general" | "loginScript">("general");
  let saveConnectionChecked = $state(false);
  let savePasswordChecked = $state(false);
  let connecting = $state(false);
  let keyUploading = $state(false);
  let error = $state<string | null>(null);
  let startupScript = $state("");
  let startupScriptReadyText = $state("");
  let keyUploadGeneration = 0;

  $effect(() => {
    activeDialogTab = "general";
    error = null;
    const pane = editPane
      ? untrack(() => tabsStore.getPane(editPane.tabId, editPane.paneId))
      : undefined;
    const paneConnection = pane?.connection;
    const paneMethod = paneConnection?.auth.method;

    if (editConnection || paneConnection) {
      const paneKeyId = paneMethod?.type === "key" ? paneMethod.key_id : undefined;
      const nextKeyId = paneConnection
        ? paneKeyId ?? ""
        : editConnection?.key_id ?? "";
      const nextSaveConnection =
        paneConnection?.saveConnection ?? Boolean(editConnection);
      name = editConnection?.name ?? paneConnection?.host ?? "";
      host = paneConnection?.host ?? editConnection?.host ?? "";
      port = paneConnection?.port ?? editConnection?.port ?? 22;
      username = paneConnection?.auth.username ?? editConnection?.username ?? "";
      keyId = nextKeyId;
      selectedKeyName = paneConnection
        ? paneConnection.keyName ??
          (paneKeyId === editConnection?.key_id ? editConnection?.key_name ?? "" : "")
        : editConnection?.key_name ?? "";
      keyPassphrase = paneMethod?.type === "key" ? paneMethod.passphrase ?? "" : "";
      authType = nextKeyId ? "key" : "password";
      saveConnectionChecked = nextSaveConnection;
      savePasswordChecked =
        nextSaveConnection &&
        (paneConnection?.savePassword ?? editConnection?.has_saved_password ?? false);
      startupScript = paneConnection?.startupScript ?? editConnection?.startup_script ?? "";
      startupScriptReadyText =
        paneConnection?.startupScriptReadyText ??
        editConnection?.startup_script_ready_text ??
        "";
      password =
        paneMethod?.type === "stored_password"
          ? STORED_PASSWORD_PLACEHOLDER
          : paneMethod?.type === "password"
            ? paneMethod.password
            : !paneConnection && editConnection?.has_saved_password
              ? STORED_PASSWORD_PLACEHOLDER
              : "";
    } else {
      resetForm();
    }
  });

  function resetForm() {
    keyUploadGeneration += 1;
    name = "";
    host = "";
    port = 22;
    username = "";
    password = "";
    keyId = "";
    keyPassphrase = "";
    selectedKeyName = "";
    authType = "password";
    saveConnectionChecked = false;
    savePasswordChecked = false;
    keyUploading = false;
    error = null;
    startupScript = "";
    startupScriptReadyText = "";
    activeDialogTab = "general";
  }


  function isPersistedKeyId(id: string): boolean {
    if (id === editConnection?.key_id) return true;
    if (connectionsStore.connections.some((connection) => connection.key_id === id)) {
      return true;
    }

    return tabsStore.tabs.some((tab) =>
      tab.panes.some((pane) => {
        const method = pane.connection.auth.method;
        return method.type === "key" && method.key_id === id;
      })
    );
  }

  async function cleanupTransientKey(id: string) {
    if (!id || isPersistedKeyId(id)) {
      return;
    }

    await cleanupUnreferencedManagedKeys([id]);
  }

  async function handleKeyFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (connecting || keyUploading) {
      input.value = "";
      return;
    }

    error = null;
    const file = input.files?.[0];
    const previousKeyId = keyId;
    const previousKeyName = selectedKeyName;

    if (!file) {
      return;
    }
    if (file.size > MAX_SSH_KEY_BYTES) {
      error = "SSH key file exceeds 1 MiB";
      input.value = "";
      return;
    }
    const keyHost = host.trim();
    const keyUsername = username.trim();
    if (
      !keyHost ||
      !keyUsername ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      error = "Enter a valid host, port, and username before selecting an SSH key";
      input.value = "";
      return;
    }

    const uploadGeneration = ++keyUploadGeneration;
    keyUploading = true;

    try {
      const buffer = await file.arrayBuffer();
      const result = await uploadSshKey(
        file.name,
        new Uint8Array(buffer),
        keyHost,
        port,
        keyUsername
      );
      if (uploadGeneration !== keyUploadGeneration) {
        await cleanupTransientKey(result.key_id);
        return;
      }

      keyId = result.key_id;
      selectedKeyName = result.file_name;

      if (previousKeyId && previousKeyId !== result.key_id) {
        await cleanupTransientKey(previousKeyId);
      }
    } catch (e) {
      if (uploadGeneration !== keyUploadGeneration) return;
      keyId = previousKeyId;
      selectedKeyName = previousKeyName;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (uploadGeneration === keyUploadGeneration) {
        keyUploading = false;
      }
      input.value = "";
    }
  }

  async function handleConnect() {
    if (connecting || keyUploading) return;

    const submission = {
      name,
      host: host.trim(),
      port,
      username: username.trim(),
      password,
      keyId,
      keyPassphrase,
      keyName: selectedKeyName,
      authType,
      saveConnection: saveConnectionChecked,
      savePassword: savePasswordChecked,
      startupScript: startupScript.trim().length > 0 ? startupScript : undefined,
      startupScriptReadyText: startupScriptReadyText.trim() || undefined,
      editConnection,
      editPane: editPane ? { ...editPane } : undefined,
    };

    error = null;
    connecting = true;

    try {
      if (!submission.host) {
        throw new Error("Host is required");
      }
      if (!submission.username) {
        throw new Error("Username is required");
      }
      if (
        !Number.isInteger(submission.port) ||
        submission.port < 1 ||
        submission.port > 65535
      ) {
        throw new Error("Port must be between 1 and 65535");
      }
      if (submission.authType === "key" && !submission.keyId) {
        throw new Error("Select an SSH private key file first");
      }

      const targetPane = submission.editPane
        ? tabsStore.getPane(submission.editPane.tabId, submission.editPane.paneId)
        : undefined;
      const previousPaneMethod = targetPane?.connection.auth.method;
      const previousPaneKeyId =
        previousPaneMethod?.type === "key" ? previousPaneMethod.key_id : undefined;
      let connectionId: string | undefined =
        submission.editConnection?.id ?? targetPane?.connection.connectionId;
      const isUsingStoredPassword =
        submission.authType === "password" &&
        submission.password === STORED_PASSWORD_PLACEHOLDER &&
        Boolean(connectionId);
      if (
        submission.authType === "password" &&
        !isUsingStoredPassword &&
        submission.password.length === 0
      ) {
        throw new Error("Password is required");
      }
      if (
        isUsingStoredPassword &&
        submission.saveConnection &&
        !submission.editConnection
      ) {
        throw new Error("Enter the password before saving this connection");
      }
      if (
        isUsingStoredPassword &&
        submission.saveConnection &&
        !submission.savePassword
      ) {
        throw new Error("Enter the password before removing secure password storage");
      }

      let canRestorePassword =
        isUsingStoredPassword && !submission.editConnection
          ? Boolean(targetPane?.connection.canRestorePassword)
          : false;
      let replacedSavedKeyId: string | undefined;
      if (submission.saveConnection) {
        const id = submission.editConnection?.id || crypto.randomUUID();
        const savePlan = buildConnectionDialogSavePlan({
          editConnection: submission.editConnection,
          connectionId: id,
          name: submission.name,
          host: submission.host,
          port: submission.port,
          username: submission.username,
          authType: submission.authType,
          password: submission.password,
          keyId: submission.keyId,
          keyName: submission.keyName,
          saveConnectionChecked: submission.saveConnection,
          savePasswordChecked: submission.savePassword,
          startupScript: submission.startupScript,
          startupScriptReadyText: submission.startupScriptReadyText,
        });
        connectionId = savePlan.connection.id;
        canRestorePassword = savePlan.canRestorePassword;
        const previousSavedKeyId = submission.editConnection?.key_id;
        if (
          previousSavedKeyId &&
          previousSavedKeyId !== savePlan.connection.key_id
        ) {
          replacedSavedKeyId = previousSavedKeyId;
          stageManagedKeyCleanup([previousSavedKeyId]);
        }
        await connectionsStore.save(savePlan.connection, savePlan.passwordToSave);
      }

      const authPlan = buildConnectionAuthPlan(
        submission.authType === "key"
          ? {
              authType: submission.authType,
              username: submission.username,
              keyId: submission.keyId,
              passphrase: submission.keyPassphrase,
            }
          : isUsingStoredPassword
            ? {
                authType: "storedPassword",
                username: submission.username,
                connectionId: connectionId!,
              }
            : {
                authType: submission.authType,
                username: submission.username,
                password: submission.password,
              }
      );
      if (replacedSavedKeyId) {
        const replacementMethod =
          canRestorePassword && connectionId
            ? { type: "stored_password" as const, connection_id: connectionId }
            : authPlan.auth.method;
        tabsStore.replaceManagedKeyReferences(replacedSavedKeyId, {
          host: submission.host,
          port: submission.port,
          auth: {
            username: submission.username,
            method: { ...replacementMethod },
          },
          connectionId,
          canRestorePassword,
          startupScript: submission.startupScript,
          startupScriptReadyText: submission.startupScriptReadyText,
          keyName:
            submission.authType === "key"
              ? submission.keyName || undefined
              : undefined,
          saveConnection: true,
          savePassword: canRestorePassword,
        } satisfies PaneConnection);
      }

      if (submission.editPane) {
        tabsStore.updatePaneConnection(
          submission.editPane.tabId,
          submission.editPane.paneId,
          {
            host: submission.host,
            port: submission.port,
            auth: authPlan.auth,
            connectionId,
            canRestorePassword,
            startupScript: submission.startupScript,
            keyName:
              submission.authType === "key"
                ? submission.keyName || undefined
                : undefined,
            saveConnection: submission.saveConnection,
            savePassword: submission.saveConnection && submission.savePassword,
            startupScriptReadyText: submission.startupScriptReadyText,
          }
        );
      } else {
        tabsStore.addTab(
          submission.host,
          submission.port,
          authPlan.auth,
          connectionId,
          canRestorePassword,
          submission.startupScript,
          submission.startupScriptReadyText,
          submission.authType === "key" ? submission.keyName || undefined : undefined,
          submission.saveConnection,
          submission.saveConnection && submission.savePassword
        );
      }

      const activeKeyId =
        submission.authType === "key" ? submission.keyId : undefined;
      if (replacedSavedKeyId) {
        await cleanupUnreferencedManagedKeys([replacedSavedKeyId]);
      }
      if (previousPaneKeyId && previousPaneKeyId !== activeKeyId) {
        await cleanupTransientKey(previousPaneKeyId);
      }
      if (
        submission.authType !== "key" &&
        submission.keyId &&
        submission.keyId !== previousPaneKeyId
      ) {
        await cleanupTransientKey(submission.keyId);
      }

      onClose();
      resetForm();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      connecting = false;
    }
  }

  async function handleCancel() {
    if (connecting) return;

    const transientKeyId = keyId;
    const transientKeyIsPersisted = isPersistedKeyId(transientKeyId);
    resetForm();
    onClose();

    if (!transientKeyIsPersisted) {
      await cleanupTransientKey(transientKeyId);
    }
  }

  function handleOverlayClick() {
    void handleCancel();
  }

  function handleDialogTabKeydown(event: KeyboardEvent) {
    const tabs = ["general", "loginScript"] as const;
    const currentIndex = tabs.indexOf(activeDialogTab);
    let nextIndex = currentIndex;

    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    activeDialogTab = tabs[nextIndex];
    const tabList = event.currentTarget instanceof HTMLElement
      ? event.currentTarget.parentElement
      : null;
    tabList
      ?.querySelector<HTMLElement>(
        '[data-dialog-tab="' + activeDialogTab + '"]'
      )
      ?.focus();
  }
</script>

{#if open}
  <div
    class="dialog-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="connection-dialog-title"
    tabindex="-1"
    use:modalFocus={{ onClose: () => void handleCancel() }}
  >
    <div class="dialog-backdrop" onclick={handleOverlayClick} aria-hidden="true"></div>
    <div class="dialog">
      <h2 id="connection-dialog-title">{editConnection || editPane ? "Edit Connection" : "New Connection"}</h2>

      {#if error}
        <div class="error">{error}</div>
      {/if}
      <div class="dialog-tabs" role="tablist" aria-label="Connection settings">
        <button
          type="button"
          disabled={connecting || keyUploading}
          id="connection-tab-general"
          data-dialog-tab="general"
          class="dialog-tab"
          class:active={activeDialogTab === "general"}
          role="tab"
          aria-selected={activeDialogTab === "general"}
          aria-controls="connection-dialog-panel"
          tabindex={activeDialogTab === "general" ? 0 : -1}
          onclick={() => (activeDialogTab = "general")}
          onkeydown={handleDialogTabKeydown}
        >
          General
        </button>
        <button
          type="button"
          disabled={connecting || keyUploading}
          id="connection-tab-login-script"
          data-dialog-tab="loginScript"
          class="dialog-tab"
          class:active={activeDialogTab === "loginScript"}
          role="tab"
          aria-selected={activeDialogTab === "loginScript"}
          aria-controls="connection-dialog-panel"
          tabindex={activeDialogTab === "loginScript" ? 0 : -1}
          onclick={() => (activeDialogTab = "loginScript")}
          onkeydown={handleDialogTabKeydown}
        >
          Startup Script
        </button>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleConnect(); }}>
        <fieldset class="dialog-fields" disabled={connecting || keyUploading}>
        <div
          class="dialog-body"
          id="connection-dialog-panel"
          role="tabpanel"
          aria-labelledby={activeDialogTab === "general"
            ? "connection-tab-general"
            : "connection-tab-login-script"}
        >
        {#if activeDialogTab === "general"}
          <div class="form-group">
            <label for="name">Name (optional)</label>
            <input
              type="text"
              id="name"
              bind:value={name}
              placeholder="My Server"
            />
          </div>

          <div class="form-row">
            <div class="form-group flex-grow">
              <label for="host">Host</label>
              <input
                type="text"
                id="host"
                bind:value={host}
                placeholder="192.168.1.1"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                required
              />
            </div>

            <div class="form-group port-field">
              <label for="port">Port</label>
              <input
                type="number"
                id="port"
                bind:value={port}
                min="1"
                max="65535"
                required
              />
            </div>
          </div>

          <div class="form-group">
            <label for="username">Username</label>
              <input
                type="text"
                id="username"
                bind:value={username}
                placeholder="root"
                autocomplete="username"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                required
              />
          </div>

          <div class="form-group">
            <span class="label-text">Authentication</span>
            <div class="auth-tabs" role="group" aria-label="Authentication method">
              <button
                type="button"
                disabled={connecting || keyUploading}
                class="auth-tab"
                class:active={authType === "password"}
                aria-pressed={authType === "password"}
                onclick={() => (authType = "password")}
              >
                Password
              </button>
              <button
                type="button"
                disabled={connecting || keyUploading}
                class="auth-tab"
                class:active={authType === "key"}
                onclick={() => (authType = "key")}
                aria-pressed={authType === "key"}
              >
                SSH Key
              </button>
            </div>
          </div>

          {#if authType === "password"}
            <div class="form-group">
              <label for="password">Password</label>
              <input
                type="password"
                id="password"
                bind:value={password}
                required
              />
            </div>
          {:else}
            <div class="form-group">
              <label for="keyFile">SSH Key File</label>
              <input
                type="file"
                id="keyFile"
                class="sr-only-file-input"
                disabled={connecting || keyUploading}
                onchange={handleKeyFileChange}
              />
              <label
                for="keyFile"
                class="file-picker-button"
                aria-busy={keyUploading}
                aria-disabled={connecting || keyUploading}
              >
                {keyUploading ? "Uploading key…" : selectedKeyName ? "Choose another key" : "Choose private key"}
              </label>
              <div class="key-help">
                {#if keyUploading}
                  <span>Uploading key file…</span>
                {:else if selectedKeyName}
                  <span>Selected: {selectedKeyName}</span>
                {:else}
                  <span>Select your private key file like id_rsa, id_ed25519, or a .pem key.</span>
                {/if}
              </div>
            </div>
            <div class="form-group">
              <label for="keyPassphrase">Key passphrase (optional)</label>
              <input
                type="password"
                id="keyPassphrase"
                bind:value={keyPassphrase}
                autocomplete="current-password"
                placeholder="Leave blank for unencrypted keys…"
              />
            </div>
          {/if}

          <div class="form-group checkbox">
            <label>
              <input type="checkbox" bind:checked={saveConnectionChecked} />
              Save connection
            </label>
          </div>

          {#if saveConnectionChecked && authType === "password"}
            <div class="form-group checkbox save-password">
              <label>
                <input type="checkbox" bind:checked={savePasswordChecked} />
                Save password securely
              </label>
            </div>
          {/if}
        {:else}
          <div class="script-fields">
            <div class="form-group">
              <label for="startupScriptReadyText">Expect</label>
              <input
                type="text"
                id="startupScriptReadyText"
                bind:value={startupScriptReadyText}
                placeholder="user@host:~$"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
              />
            </div>

            <div class="form-group">
              <label for="startupScript">Send</label>
              <textarea
                id="startupScript"
                class="startup-script-input"
                bind:value={startupScript}
                rows="7"
                placeholder="export TERM=xterm-256color&#10;cd ~/project"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                {...{ autocorrect: "off" }}
              ></textarea>
            </div>
          </div>
          <div class="script-help">
            If Expect is blank, RedTerm sends immediately after the SSH session opens. If set, RedTerm waits until terminal output contains that exact text.
          </div>
        {/if}

        </div>
        </fieldset>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn-cancel"
            disabled={connecting}
            onclick={() => void handleCancel()}
          >
            Cancel
          </button>
          <button type="submit" class="btn-connect" disabled={connecting || keyUploading}>
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 16px;
  }

  .dialog-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
  }

  .dialog {
    position: relative;
    background: var(--bg-primary);
    border-radius: 12px;
    width: 100%;
    /* Shells can widen for desktop via --dialog-max-width. */
    max-width: var(--dialog-max-width, 400px);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  h2 {
    margin: 0 0 16px;
    padding: 24px 24px 0;
    color: var(--text-primary);
    font-size: 18px;
  }

  .error {
    background: rgba(243, 139, 168, 0.2);
    border: 1px solid var(--status-error);
    color: var(--status-error);
    padding: 10px;
    border-radius: 6px;
    margin: 0 24px 16px;
    font-size: 13px;
  }
  .dialog-tabs {
    display: flex;
    gap: 8px;
    margin: 0 24px;
    border-bottom: 1px solid var(--border-secondary);
  }

  .dialog-tab {
    flex: 1;
    padding: 10px 8px;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .dialog-tab.active {
    border-bottom-color: var(--accent-primary);
    color: var(--text-primary);
  }

  form {
    min-height: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
  }

  .dialog-fields {
    min-width: 0;
    min-height: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex: 1 1 auto;
    border: 0;
    overflow: hidden;
  }

  .dialog-body {
    min-height: 0;
    flex: 1 1 auto;
    padding: 20px 24px 0;
    overflow-y: auto;
  }


  .form-group {
    margin-bottom: 16px;
  }

  .form-row {
    display: flex;
    gap: 12px;
  }

  .flex-grow {
    flex: 1;
  }

  .port-field {
    width: 80px;
  }

  label, .label-text {
    display: block;
    margin-bottom: 6px;
    color: var(--text-secondary);
    font-size: 13px;
  }

  input[type="text"],
  input[type="password"],
  input[type="number"],
  textarea {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 14px;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }
  textarea {
    resize: vertical;
    min-height: 160px;
    font-family: "Sarasa Term K Nerd", "JetBrains Mono", "Fira Code", monospace;
    line-height: 1.4;
  }

  .script-help {
    margin-top: 8px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.4;
  }
  .script-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }


  .key-help {
    margin-top: 8px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.4;
  }

  .sr-only-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .file-picker-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-secondary));
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-sizing: border-box;
    transition: background-color 0.15s, border-color 0.15s, transform 0.15s;
  }

  .file-picker-button:hover {
    background: color-mix(in srgb, var(--accent-primary) 26%, var(--bg-secondary));
    border-color: var(--accent-primary);
  }

  .file-picker-button:active {
    transform: translateY(1px);
  }

  .file-picker-button[aria-busy="true"] {
    opacity: 0.8;
    cursor: progress;
  }

  .auth-tabs {
    display: flex;
    gap: 4px;
  }

  .auth-tab {
    flex: 1;
    padding: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-secondary);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }

  .auth-tab:first-child {
    border-radius: 6px 0 0 6px;
  }

  .auth-tab:last-child {
    border-radius: 0 6px 6px 0;
  }

  .auth-tab.active {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--bg-primary);
  }

  .checkbox label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .checkbox input {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-primary);
  }

  .save-password {
    margin-left: 24px;
    margin-top: -8px;
  }

  .save-password label {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .dialog-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 12px;
    margin: 0;
    padding: 16px 24px 24px;
    border-top: 1px solid var(--border-secondary);
    background: var(--bg-primary);
  }

  .btn-cancel,
  .btn-connect {
    flex: 1;
    padding: 12px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .btn-cancel {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .btn-cancel:hover {
    background: var(--bg-tertiary);
  }

  .btn-connect {
    background: var(--accent-primary);
    color: var(--bg-primary);
  }

  .btn-connect:hover {
    background: var(--accent-hover);
  }

  .btn-connect:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
