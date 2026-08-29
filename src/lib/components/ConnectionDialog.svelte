<script lang="ts">
  import { connectionsStore } from "$lib/stores/connections.svelte";
  import { tabsStore } from "$lib/stores/tabs.svelte";
  import {
    deleteUploadedSshKey,
    MAX_SSH_KEY_BYTES,
    uploadSshKey,
    type AuthConfig,
    type SavedConnection,
  } from "$lib/tauri/commands";
  import {
    STORED_PASSWORD_PLACEHOLDER,
    buildConnectionDialogSavePlan,
  } from "./connection-dialog-save-plan";
  import { buildConnectionAuthPlan } from "./connection-auth-plan";

  interface Props {
    open: boolean;
    editConnection?: SavedConnection;
    onClose: () => void;
  }

  let { open, editConnection, onClose }: Props = $props();


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

  $effect(() => {
    activeDialogTab = "general";
    if (editConnection) {
      name = editConnection.name;
      host = editConnection.host;
      port = editConnection.port;
      username = editConnection.username;
      keyId = editConnection.key_id || "";
      selectedKeyName = editConnection.key_name || "";
      keyPassphrase = "";
      authType = editConnection.key_id ? "key" : "password";
      saveConnectionChecked = true;
      savePasswordChecked = editConnection.has_saved_password;
      startupScript = editConnection.startup_script || "";
      startupScriptReadyText = editConnection.startup_script_ready_text || "";
      // Show placeholder for stored password
      password = editConnection.has_saved_password ? STORED_PASSWORD_PLACEHOLDER : "";
    } else {
      resetForm();
    }
  });

  function resetForm() {
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
    return Boolean(editConnection?.key_id && id === editConnection.key_id);
  }

  async function cleanupTransientKey(id: string) {
    if (!id || isPersistedKeyId(id)) {
      return;
    }

    try {
      await deleteUploadedSshKey(id);
    } catch (e) {
      console.error("Failed to delete uploaded SSH key:", e);
    }
  }

  async function handleKeyFileChange(event: Event) {
    error = null;
    const input = event.currentTarget as HTMLInputElement;
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
      keyId = result.key_id;
      selectedKeyName = result.file_name;

      if (previousKeyId && previousKeyId !== result.key_id) {
        await cleanupTransientKey(previousKeyId);
      }
    } catch (e) {
      keyId = previousKeyId;
      selectedKeyName = previousKeyName;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      keyUploading = false;
      input.value = "";
    }
  }

  async function handleConnect() {
    error = null;
    connecting = true;

    try {
      const trimmedHost = host.trim();
      const trimmedUsername = username.trim();
      const startupScriptToUse = startupScript.trim().length > 0 ? startupScript : undefined;
      const startupScriptReadyTextToUse = startupScriptReadyText.trim() || undefined;

      if (!trimmedHost) {
        throw new Error("Host is required");
      }
      if (!trimmedUsername) {
        throw new Error("Username is required");
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Port must be between 1 and 65535");
      }

      if (authType === "key" && !keyId) {
        throw new Error("Select an SSH private key file first");
      }

      let connectionId: string | undefined = editConnection?.id;
      const isUsingStoredPassword =
        authType === "password" &&
        password === STORED_PASSWORD_PLACEHOLDER &&
        Boolean(editConnection?.id);
      if (authType === "password" && !isUsingStoredPassword && password.length === 0) {
        throw new Error("Password is required");
      }
      if (isUsingStoredPassword && saveConnectionChecked && !savePasswordChecked) {
        throw new Error("Enter the password before removing secure password storage");
      }

      let canRestorePassword = false;

      if (saveConnectionChecked) {
        const id = editConnection?.id || crypto.randomUUID();
        const savePlan = buildConnectionDialogSavePlan({
          editConnection,
          connectionId: id,
          name,
          host: trimmedHost,
          port,
          username: trimmedUsername,
          authType,
          password,
          keyId,
          keyName: selectedKeyName,
          saveConnectionChecked,
          savePasswordChecked,
          startupScript: startupScriptToUse,
          startupScriptReadyText: startupScriptReadyTextToUse,
        });
        connectionId = savePlan.connection.id;
        canRestorePassword = savePlan.canRestorePassword;
        await connectionsStore.save(savePlan.connection, savePlan.passwordToSave);
      }

      const authPlan = buildConnectionAuthPlan(
        authType === "key"
          ? {
              authType,
              username: trimmedUsername,
              keyId,
              passphrase: keyPassphrase,
            }
          : isUsingStoredPassword
            ? {
                authType: "storedPassword",
                username: trimmedUsername,
                connectionId: connectionId!,
              }
            : {
                authType,
                username: trimmedUsername,
                password,
              }
      );

      tabsStore.addTab(
        trimmedHost,
        port,
        authPlan.auth,
        connectionId,
        canRestorePassword,
        startupScriptToUse,
        startupScriptReadyTextToUse
      );

      onClose();
      resetForm();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      connecting = false;
    }
  }

  async function handleCancel() {
    const transientKeyId = keyId;
    resetForm();

    await cleanupTransientKey(transientKeyId);
    onClose();
  }

  function handleOverlayClick() {
    void handleCancel();
  }

  function handleOverlayKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      void handleCancel();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="dialog-overlay"
    onclick={handleOverlayClick}
    onkeydown={handleOverlayKeydown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dialog" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <h2>{editConnection ? "Edit Connection" : "New Connection"}</h2>

      {#if error}
        <div class="error">{error}</div>
      {/if}
      <div class="dialog-tabs" role="tablist" aria-label="Connection settings">
        <button
          type="button"
          class="dialog-tab"
          class:active={activeDialogTab === "general"}
          onclick={() => (activeDialogTab = "general")}
        >
          General
        </button>
        <button
          type="button"
          class="dialog-tab"
          class:active={activeDialogTab === "loginScript"}
          onclick={() => (activeDialogTab = "loginScript")}
        >
          Startup Script
        </button>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleConnect(); }}>
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
            <div class="auth-tabs">
              <button
                type="button"
                class="auth-tab"
                class:active={authType === "password"}
                onclick={() => (authType = "password")}
              >
                Password
              </button>
              <button
                type="button"
                class="auth-tab"
                class:active={authType === "key"}
                onclick={() => (authType = "key")}
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
              <input type="file" id="keyFile" class="sr-only-file-input" onchange={handleKeyFileChange} />
              <label for="keyFile" class="file-picker-button" aria-busy={keyUploading}>
                {keyUploading ? "Uploading key..." : selectedKeyName ? "Choose another key" : "Choose private key"}
              </label>
              <div class="key-help">
                {#if keyUploading}
                  <span>Uploading key file...</span>
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

        <div class="dialog-actions">
          <button type="button" class="btn-cancel" onclick={() => void handleCancel()}>
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
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 16px;
  }

  .dialog {
    background: var(--bg-primary);
    border-radius: 12px;
    padding: 24px;
    width: 100%;
    /* Shells can widen for desktop via --dialog-max-width. */
    max-width: var(--dialog-max-width, 400px);
    max-height: 90vh;
    overflow-y: auto;
  }

  h2 {
    margin: 0 0 16px;
    color: var(--text-primary);
    font-size: 18px;
  }

  .error {
    background: rgba(243, 139, 168, 0.2);
    border: 1px solid var(--status-error);
    color: var(--status-error);
    padding: 10px;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 13px;
  }
  .dialog-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
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
    transition: all 0.15s;
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
    gap: 12px;
    margin-top: 24px;
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
