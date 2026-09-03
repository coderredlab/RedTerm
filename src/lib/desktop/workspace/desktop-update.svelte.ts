/** Desktop-only in-app update flow backed by the Tauri updater plugin. */
import {
  installDesktopUpdate,
  relaunchDesktopApp,
  checkDesktopUpdate,
  confirmAction,
  type DesktopUpdateInfo,
} from "$lib/tauri/commands";

export type DesktopUpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; update: DesktopUpdateInfo }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "ready"; update: DesktopUpdateInfo }
  | { kind: "error"; message: string };

function createDesktopUpdate() {
  let phase = $state<DesktopUpdatePhase>({ kind: "idle" });
  /** App-level restart gate (session/document checks) registered by the desktop shell. */
  let restartHandler: (() => Promise<void>) | null = null;
  /** App-level install confirmation modal; falls back to the native dialog when unset. */
  let installConfirmHandler: (() => Promise<boolean>) | null = null;

  return {
    get phase() {
      return phase;
    },
    setRestartHandler(handler: () => Promise<void>) {
      restartHandler = handler;
    },
    setInstallConfirmHandler(handler: () => Promise<boolean>) {
      installConfirmHandler = handler;
    },
    /** Probe for an update without surfacing errors; returns the pending update if any. */
    async checkQuietly(): Promise<DesktopUpdateInfo | null> {
      if (phase.kind !== "idle") return null;
      phase = { kind: "checking" };
      try {
        const update = await checkDesktopUpdate();
        phase = update ? { kind: "available", update } : { kind: "upToDate" };
        return update;
      } catch {
        phase = { kind: "idle" };
        return null;
      }
    },
    /** User-initiated check; failures surface as an error phase. */
    async check(): Promise<void> {
      if (phase.kind === "checking" || phase.kind === "downloading") return;
      phase = { kind: "checking" };
      try {
        const update = await checkDesktopUpdate();
        phase = update ? { kind: "available", update } : { kind: "upToDate" };
      } catch {
        phase = {
          kind: "error",
          message: "Could not check for updates. Please try again.",
        };
      }
    },
    async install(
      options: { platformWarningAcknowledged?: boolean } = {}
    ): Promise<void> {
      if (phase.kind !== "available") return;
      const update = phase.update;
      if (navigator.userAgent.includes("Windows") && !options.platformWarningAcknowledged) {
        const confirmed = installConfirmHandler
          ? await installConfirmHandler()
          : await confirmAction(
              "The update installer will close RedTerm to finish installing. Active terminal sessions will be disconnected. Continue?"
            );
        if (!confirmed) return;
      }
      phase = { kind: "downloading", downloaded: 0, total: null };
      try {
        await installDesktopUpdate((downloaded, total) => {
          phase = { kind: "downloading", downloaded, total };
        });
        phase = { kind: "ready", update };
      } catch {
        phase = {
          kind: "error",
          message: "The update could not be installed. Please try again.",
        };
      }
    },
    async restart(): Promise<void> {
      if (restartHandler) {
        await restartHandler();
        return;
      }
      await relaunchDesktopApp();
    },
  };
}

export const desktopUpdateStore = createDesktopUpdate();
