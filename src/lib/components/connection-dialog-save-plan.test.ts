// @ts-nocheck
import { describe, expect, test } from "bun:test";

import type { SavedConnection } from "../tauri/commands";
import {
  STORED_PASSWORD_PLACEHOLDER,
  buildConnectionDialogSavePlan,
} from "./connection-dialog-save-plan";

const savedPasswordConnection = {
  id: "conn-existing-password",
  name: "Production shell",
  host: "prod.example.com",
  port: 2222,
  username: "deploy",
  has_saved_password: true,
  use_keyboard_interactive: false,
} satisfies SavedConnection;

function storedPasswordEditInput(savePasswordChecked: boolean) {
  return {
    editConnection: savedPasswordConnection,
    name: savedPasswordConnection.name,
    host: savedPasswordConnection.host,
    port: savedPasswordConnection.port,
    username: savedPasswordConnection.username,
    authType: "password" as const,
    password: STORED_PASSWORD_PLACEHOLDER,
    keyId: "",
    keyName: "",
    saveConnectionChecked: true,
    savePasswordChecked,
    startupScript: "",
    startupScriptReadyText: "",
  };
}

describe("connection dialog saved password edit planning", () => {
  test("removes secure password storage and disables tab restore when the stored password is unchecked", () => {
    const plan = buildConnectionDialogSavePlan(storedPasswordEditInput(false));

    expect(plan.connection).toMatchObject({
      id: savedPasswordConnection.id,
      name: savedPasswordConnection.name,
      host: savedPasswordConnection.host,
      port: savedPasswordConnection.port,
      username: savedPasswordConnection.username,
      use_keyboard_interactive: false,
    });
    expect(plan.connection.has_saved_password).toBe(false);
    expect(plan.passwordToSave).toBeUndefined();
    expect(plan.canRestorePassword).toBe(false);
  });

  test("keeps secure password storage enabled when the stored password remains checked", () => {
    const plan = buildConnectionDialogSavePlan(storedPasswordEditInput(true));

    expect(plan.connection.has_saved_password).toBe(true);
    expect(plan.passwordToSave).toBeUndefined();
    expect(plan.canRestorePassword).toBe(true);
  });
});
