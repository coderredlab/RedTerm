import type { SavedConnection } from "../tauri/commands";

export const STORED_PASSWORD_PLACEHOLDER = "••••••••••••";

type ConnectionDialogAuthType = "password" | "key";

interface BuildConnectionDialogSavePlanInput {
  editConnection?: SavedConnection;
  connectionId?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: ConnectionDialogAuthType;
  password: string;
  actualPassword: string;
  keyPath: string;
  saveConnectionChecked: boolean;
  savePasswordChecked: boolean;
  startupScript?: string;
  startupScriptReadyText?: string;
}

interface ConnectionDialogSavePlan {
  connection: SavedConnection;
  passwordToSave?: string;
  canRestorePassword: boolean;
}

export function buildConnectionDialogSavePlan({
  editConnection,
  connectionId,
  name,
  host,
  port,
  username,
  authType,
  password,
  actualPassword,
  keyPath,
  saveConnectionChecked,
  savePasswordChecked,
  startupScript,
  startupScriptReadyText,
}: BuildConnectionDialogSavePlanInput): ConnectionDialogSavePlan {
  const isUsingStoredPassword = password === STORED_PASSWORD_PLACEHOLDER && Boolean(editConnection?.id);
  const passwordToSave = authType === "password" && savePasswordChecked && !isUsingStoredPassword
    ? actualPassword
    : undefined;

  return {
    connection: {
      id: connectionId ?? editConnection?.id ?? crypto.randomUUID(),
      name: name || `${username}@${host}`,
      host,
      port,
      username,
      key_path: authType === "key" ? keyPath : undefined,
      has_saved_password:
        authType === "password" && saveConnectionChecked && savePasswordChecked,
      use_keyboard_interactive: false,
      startup_script: startupScript,
      startup_script_ready_text: startupScriptReadyText,
    },
    passwordToSave,
    canRestorePassword: authType === "password" && saveConnectionChecked && savePasswordChecked,
  };
}
