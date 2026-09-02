import { getContext, setContext } from "svelte";

export interface WorkspaceApi {
  registerTerminal(paneId: string, terminal: unknown): void;
  unregisterTerminal(paneId: string, terminal: unknown): void;
  paneConnected(tabId: string, paneId: string, sessionId: string): void;
  paneDisconnected(tabId: string, paneId: string): void;
  paneRetrying(tabId: string, paneId: string): void;
  editPaneConnection(tabId: string, paneId: string): void;
  closeTab(tabId: string): void;
  closePane(tabId: string, paneId: string): void;
  closeDocument(tabId: string, documentId: string): void;
  splitPane(tabId: string, paneId: string, dir: "row" | "col"): void;
  addPaneTab(tabId: string, paneId: string): void;
  activatePane(tabId: string, paneId: string): void;
  activateDocument(tabId: string, documentId: string): void;
  /** Commit a pane drag that ended over the workspace. */
  paneDragDropped(tabId: string, paneId: string): void;
}

const WORKSPACE_KEY = Symbol("redterm-desktop-workspace");

export function setWorkspaceApi(api: WorkspaceApi): void {
  setContext(WORKSPACE_KEY, api);
}

export function getWorkspaceApi(): WorkspaceApi {
  return getContext<WorkspaceApi>(WORKSPACE_KEY);
}
