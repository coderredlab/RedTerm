import { invoke } from "@tauri-apps/api/core";

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TerminalSnapshot } from "$lib/terminal/ansi-parser";
import type {
  VoiceInputEvent,
  VoiceInputLanguage,
  VoicePermissionState,
} from "$lib/voice/voice-input-controller";
import { VOICE_INPUT_EVENT } from "$lib/voice/voice-input-controller";

export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SSH_KEY_BYTES = 1024 * 1024;

export interface AuthConfig {
  username: string;
  method: AuthMethod;
}

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "stored_password"; connection_id: string }
  | { type: "key"; key_id: string; passphrase?: string };

export interface SshDataEvent {
  session_id: string;
  seq: number;
  data: number[];
}

export interface SshSessionExitEvent {
  session_id: string;
}

export interface SshSessionOutput {
  seq: number;
  data: number[];
}

export interface StoredSessionSnapshot {
  snapshot: TerminalSnapshot;
  last_seq: number;
}

export type RemoteOsKind = "linux" | "macos" | "windows" | "unknown";

export interface SshImageUploadResult {
  remote_path: string;
  remote_os: RemoteOsKind;
}

export interface ClipboardImageResult {
  found: boolean;
  localPath?: string;
}


export interface UploadedSshKeyResult {
  key_id: string;
  file_name: string;
}

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  key_id?: string;
  key_name?: string;
  has_saved_password: boolean;
  use_keyboard_interactive: boolean;
  startup_script?: string;
  startup_script_ready_text?: string;
}

export interface KnownHostEntry {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  public_key: string;
}

export type HostKeyCheckResult =
  | { status: "trusted" }
  | {
      status: "unknown" | "changed";
      algorithm: string;
      fingerprint: string;
      public_key: string;
      known_fingerprints?: string[];
      challenge_token: string;
    };

export async function sshConnect(
  host: string,
  port: number,
  auth: AuthConfig,
  cols: number,
  rows: number
): Promise<string> {
  return invoke<string>("ssh_connect", { host, port, auth, cols, rows });
}

export async function sshCheckHostKey(host: string, port: number): Promise<HostKeyCheckResult> {
  return invoke<HostKeyCheckResult>("ssh_check_host_key", { host, port });
}

export async function sshTrustHostKey(challengeToken: string): Promise<void> {
  return invoke("ssh_trust_host_key", { challengeToken });
}

export async function listKnownHosts(): Promise<KnownHostEntry[]> {
  return invoke<KnownHostEntry[]>("list_known_hosts");
}

export async function deleteKnownHost(host: string, port: number): Promise<void> {
  return invoke("delete_known_host", { host, port });
}

export async function sshWrite(sessionId: string, data: Uint8Array): Promise<void> {
  return invoke("ssh_write", { sessionId, data: Array.from(data) });
}

export async function sshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("ssh_resize", { sessionId, cols, rows });
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  return invoke("ssh_disconnect", { sessionId });
}

export async function sshSessionExists(sessionId: string): Promise<boolean> {
  return invoke<boolean>("ssh_session_exists", { sessionId });
}

export async function getRuntimeInstanceId(): Promise<string> {
  return invoke<string>("get_runtime_instance_id");
}

export async function sshGetSessionOutput(
  sessionId: string
): Promise<Array<{ seq: number; data: Uint8Array }>> {
  const result = await invoke<SshSessionOutput[]>("ssh_get_session_output", { sessionId });
  return result.map((chunk) => ({
    seq: chunk.seq,
    data: new Uint8Array(chunk.data),
  }));
}

export async function sshStoreSessionSnapshot(
  sessionId: string,
  snapshot: TerminalSnapshot,
  lastSeq: number
): Promise<void> {
  return invoke("ssh_store_session_snapshot", { sessionId, snapshot, lastSeq });
}

export async function sshGetSessionSnapshot(
  sessionId: string
): Promise<StoredSessionSnapshot | null> {
  return invoke<StoredSessionSnapshot | null>("ssh_get_session_snapshot", { sessionId });
}

export async function sshUploadClipboardImage(
  sessionId: string,
  data: Uint8Array
): Promise<SshImageUploadResult> {
  if (data.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("Clipboard image exceeds 10 MiB");
  }
  return invoke<SshImageUploadResult>("ssh_upload_clipboard_image", {
    sessionId,
    data,
  });
}

export async function sshUploadClipboardImageFromLocalPath(
  sessionId: string,
  localPath: string
): Promise<SshImageUploadResult> {
  return invoke<SshImageUploadResult>("ssh_upload_clipboard_image_from_local_path", {
    sessionId,
    localPath,
  });
}

export async function uploadSshKey(
  fileName: string,
  data: Uint8Array,
  host: string,
  port: number,
  username: string
): Promise<UploadedSshKeyResult> {
  if (data.byteLength > MAX_SSH_KEY_BYTES) {
    throw new Error("SSH key file exceeds 1 MiB");
  }
  return invoke<UploadedSshKeyResult>("upload_ssh_key", {
    fileName,
    data,
    host,
    port,
    username,
  });
}
export async function deleteUploadedSshKey(keyId: string): Promise<void> {
  return invoke("delete_uploaded_ssh_key", { keyId });
}

export async function listenSshData(
  sessionId: string,
  callback: (data: Uint8Array, seq: number) => void
): Promise<UnlistenFn> {
  return listen<SshDataEvent>(`ssh-data-${sessionId}`, (event) => {
    callback(new Uint8Array(event.payload.data), event.payload.seq);
  });
}

export async function listenSshExit(
  sessionId: string,
  callback: () => void
): Promise<UnlistenFn> {
  return listen<SshSessionExitEvent>(`ssh-exit-${sessionId}`, () => {
    callback();
  });
}

export async function loadConnections(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>("load_connections");
}

export async function saveConnection(connection: SavedConnection, password?: string): Promise<void> {
  return invoke("save_connection", { connection, password });
}


export async function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  return invoke<ClipboardImageResult>("read_clipboard_image");
}

export async function setKeepScreenOn(enabled: boolean): Promise<void> {
  return invoke("set_keep_screen_on", { enabled });
}

export async function setKeyboardVisible(visible: boolean): Promise<void> {
  return invoke("set_keyboard_visible", { visible });
}

export interface SftpDirEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number;
}

export interface SftpFileContent {
  path: string;
  content_base64: string;
  size: number;
}

export interface SftpDownloadedFile {
  remote_path: string;
  local_path: string;
  size: number;
}

export const MAX_SFTP_READ_BYTES = 2 * 1024 * 1024;
export const MAX_SFTP_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export async function sftpListDir(
  sessionId: string,
  path: string
): Promise<SftpDirEntry[]> {
  return invoke<SftpDirEntry[]>("sftp_list_dir", { sessionId, path });
}

export async function sftpReadFile(
  sessionId: string,
  path: string
): Promise<SftpFileContent> {
  return invoke<SftpFileContent>("sftp_read_file", { sessionId, path });
}

export async function sftpDownloadFile(
  sessionId: string,
  remotePath: string
): Promise<SftpDownloadedFile> {
  return invoke<SftpDownloadedFile>("sftp_download_file", {
    sessionId,
    remotePath,
  });
}

export async function sftpHomeDir(sessionId: string): Promise<string> {
  return invoke<string>("sftp_home_dir", { sessionId });
}

export async function sftpDownloadToDownloads(
  sessionId: string,
  remotePath: string
): Promise<SftpDownloadedFile> {
  return invoke<SftpDownloadedFile>("sftp_download_to_downloads", {
    sessionId,
    remotePath,
  });
}


export async function checkVoiceInputPermissions(): Promise<{ microphone?: VoicePermissionState }> {
  return invoke<{ microphone?: VoicePermissionState }>("check_voice_input_permissions");
}

export async function requestVoiceInputPermissions(): Promise<{ microphone?: VoicePermissionState }> {
  return invoke<{ microphone?: VoicePermissionState }>("request_voice_input_permissions");
}

export async function listVoiceInputLanguages(): Promise<VoiceInputLanguage[]> {
  return invoke<VoiceInputLanguage[]>("list_voice_input_languages");
}

export async function startVoiceInput(languageTag: string): Promise<void> {
  return invoke("start_voice_input", { languageTag });
}

export async function stopVoiceInput(): Promise<void> {
  return invoke("stop_voice_input");
}

export async function cancelVoiceInput(): Promise<void> {
  return invoke("cancel_voice_input");
}

export async function listenVoiceInput(
  callback: (event: VoiceInputEvent) => void
): Promise<UnlistenFn> {
  const handler = (event: Event) => {
    callback((event as CustomEvent<VoiceInputEvent>).detail);
  };
  window.addEventListener(VOICE_INPUT_EVENT, handler);
  return () => window.removeEventListener(VOICE_INPUT_EVENT, handler);
}
