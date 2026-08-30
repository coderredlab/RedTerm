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
  keyId: string;
  keyName: string;
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
  keyId,
  keyName,
  saveConnectionChecked,
  savePasswordChecked,
  startupScript,
  startupScriptReadyText,
}: BuildConnectionDialogSavePlanInput): ConnectionDialogSavePlan {
  const isUsingStoredPassword =
    password === STORED_PASSWORD_PLACEHOLDER &&
    Boolean(connectionId ?? editConnection?.id);
  const passwordToSave = authType === "password" && savePasswordChecked && !isUsingStoredPassword
    ? password
    : undefined;

  return {
    connection: {
      id: connectionId ?? editConnection?.id ?? crypto.randomUUID(),
      name: name || `${username}@${host}`,
      host,
      port,
      username,
      key_id: authType === "key" ? keyId : undefined,
      key_name: authType === "key" ? keyName : undefined,
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
