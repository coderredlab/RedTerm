import { tick } from "svelte";
import type { AuthConfig } from "$lib/tauri/commands";

/** Connection target owned by a single terminal pane. */
export interface PaneConnection {
  host: string;
  port: number;
  auth: AuthConfig;
  connectionId?: string;
  canRestorePassword?: boolean;
  startupScript?: string;
  startupScriptReadyText?: string;
}

/** One terminal instance slot. Each pane owns its connection target and session. */
export interface Pane {
  id: string;
  tabId: string;
  title: string;
  connection: PaneConnection;
  sessionId: string | null;
  runtimeInstanceId?: string | null;
  connected: boolean;
  /** When true, Terminal teardown must keep the remote session alive (desktop pane move). */
  preserveSessionOnMove?: boolean;
}

export type PaneNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      id: string;
      dir: "row" | "col";
      ratio: number;
      children: [PaneNode, PaneNode];
    };

export interface Tab {
  id: string;
  title: string;
  // Legacy single-connection surface, mirrored from the primary pane.
  // MobileApp and shared components rely on these fields.
  host: string;
  port: number;
  auth: AuthConfig;
  connectionId?: string;
  canRestorePassword?: boolean;
  startupScript?: string;
  startupScriptReadyText?: string;
  sessionId: string | null;
  runtimeInstanceId?: string | null;
  connected: boolean;
  // Pane model. Every tab has at least one pane; legacy single-pane tabs
  // simply hold exactly one.
  panes: Pane[];
  layout: PaneNode;
  activePaneId: string | null;
}

interface PersistedTabsStateV1 {
  tabs: Tab[];
  activeTabId: string | null;
}

interface PersistedTabsStateV2 {
  version: 2;
  tabs: Tab[];
  activeTabId: string | null;
}

const STORAGE_KEY = "redterm.tabs.v2";
const LEGACY_STORAGE_KEY = "redterm.tabs.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function makePersistableAuth(
  auth: AuthConfig,
  connectionId?: string,
  canRestorePassword = false
): AuthConfig {
  if (auth.method.type === "key") {
    return {
      username: auth.username,
      method: { type: "key", key_id: auth.method.key_id },
    };
  }
  if (auth.method.type === "stored_password") {
    return auth;
  }
  if (connectionId && canRestorePassword) {
    return {
      username: auth.username,
      method: { type: "stored_password", connection_id: connectionId },
    };
  }
  return {
    username: auth.username,
    method: { type: "password", password: "" },
  };
}

function canPersistPane(pane: Pane): boolean {
  const auth = pane.connection.auth;
  if (auth.method.type === "key") {
    return Boolean(auth.method.key_id);
  }
  if (auth.method.type === "stored_password") {
    return Boolean(pane.connection.connectionId);
  }
  return Boolean(
    pane.sessionId ||
      (pane.connection.connectionId && pane.connection.canRestorePassword)
  );
}

function paneTitle(connection: PaneConnection): string {
  return `${connection.auth.username}@${connection.host}`;
}

function makePane(
  tabId: string,
  connection: PaneConnection,
  paneId?: string
): Pane {
  return {
    id: paneId ?? crypto.randomUUID(),
    tabId,
    title: paneTitle(connection),
    connection,
    sessionId: null,
    runtimeInstanceId: null,
    connected: false,
  };
}

function leaf(paneId: string): PaneNode {
  return { type: "leaf", paneId };
}

function makeSplit(
  dir: "row" | "col",
  ratio: number,
  children: [PaneNode, PaneNode]
): PaneNode {
  return { type: "split", id: crypto.randomUUID(), dir, ratio, children };
}

function collectPaneIds(node: PaneNode, into: string[] = []): string[] {
  if (node.type === "leaf") {
    into.push(node.paneId);
  } else {
    collectPaneIds(node.children[0], into);
    collectPaneIds(node.children[1], into);
  }
  return into;
}

function pruneLayout(node: PaneNode, alive: Set<string>): PaneNode | null {
  if (node.type === "leaf") {
    return alive.has(node.paneId) ? node : null;
  }
  const first = pruneLayout(node.children[0], alive);
  const second = pruneLayout(node.children[1], alive);
  if (first && second) {
    return { ...node, children: [first, second] as [PaneNode, PaneNode] };
  }
  return first ?? second;
}

function replaceLeaf(
  node: PaneNode,
  paneId: string,
  transform: (leafNode: PaneNode) => PaneNode
): PaneNode {
  if (node.type === "leaf") {
    return node.paneId === paneId ? transform(node) : node;
  }
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], paneId, transform),
      replaceLeaf(node.children[1], paneId, transform),
    ] as [PaneNode, PaneNode],
  };
}

function updateRatio(
  node: PaneNode,
  splitId: string,
  ratio: number
): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    children: [
      updateRatio(node.children[0], splitId, ratio),
      updateRatio(node.children[1], splitId, ratio),
    ] as [PaneNode, PaneNode],
  };
}

function validateLayout(node: unknown, validPaneIds: Set<string>): PaneNode | null {
  if (!node || typeof node !== "object") return null;
  const candidate = node as Partial<PaneNode>;
  if (candidate.type === "leaf") {
    const leafNode = candidate as { type: "leaf"; paneId?: unknown };
    return typeof leafNode.paneId === "string" && validPaneIds.has(leafNode.paneId)
      ? leaf(leafNode.paneId)
      : null;
  }
  if (candidate.type === "split") {
    const splitNode = candidate as {
      type: "split";
      dir?: unknown;
      ratio?: unknown;
      children?: unknown;
    };
    if (
      (splitNode.dir !== "row" && splitNode.dir !== "col") ||
      typeof splitNode.ratio !== "number" ||
      !Array.isArray(splitNode.children) ||
      splitNode.children.length !== 2
    ) {
      return null;
    }
    const first = validateLayout(splitNode.children[0], validPaneIds);
    const second = validateLayout(splitNode.children[1], validPaneIds);
    if (!first || !second) return null;
    return makeSplitWithId(
      { dir: splitNode.dir as "row" | "col", ratio: splitNode.ratio as number },
      first,
      second
    );
  }
  return null;
}

function makeSplitWithId(
  source: { dir: "row" | "col"; ratio: number },
  first: PaneNode,
  second: PaneNode
): PaneNode {
  const ratio = Number.isFinite(source.ratio)
    ? Math.min(0.9, Math.max(0.1, source.ratio))
    : 0.5;
  return {
    type: "split",
    id: crypto.randomUUID(),
    dir: source.dir,
    ratio,
    children: [first, second],
  };
}

function validatePane(candidate: unknown, tabId: string): Pane | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as Partial<Pane> & {
    connection?: Partial<PaneConnection>;
  };
  const connection = raw.connection;
  if (
    typeof raw.id !== "string" ||
    !connection ||
    typeof connection.host !== "string" ||
    typeof connection.port !== "number" ||
    !connection.auth ||
    typeof connection.auth.username !== "string" ||
    !connection.auth.method
  ) {
    return null;
  }
  const persistedConnection: PaneConnection = {
    host: connection.host,
    port: connection.port,
    auth: makePersistableAuth(
      connection.auth as AuthConfig,
      connection.connectionId,
      Boolean(connection.canRestorePassword)
    ),
    connectionId: connection.connectionId,
    canRestorePassword: connection.canRestorePassword,
    startupScript: connection.startupScript,
    startupScriptReadyText: connection.startupScriptReadyText,
  };
  const pane: Pane = {
    id: raw.id,
    tabId,
    title: paneTitle(persistedConnection),
    connection: persistedConnection,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    runtimeInstanceId:
      typeof raw.runtimeInstanceId === "string" ? raw.runtimeInstanceId : null,
    connected: false,
  };
  return canPersistPane(pane) ? pane : null;
}

/** Recompute legacy tab-level fields from the pane model. */
function syncTabFromPanes(tab: Tab) {
  const primary = tab.panes[0];
  const active =
    tab.panes.find((pane) => pane.id === tab.activePaneId) ?? primary;
  if (primary) {
    tab.host = primary.connection.host;
    tab.port = primary.connection.port;
    tab.auth = primary.connection.auth;
    tab.connectionId = primary.connection.connectionId;
    tab.canRestorePassword = primary.connection.canRestorePassword;
    tab.startupScript = primary.connection.startupScript;
    tab.startupScriptReadyText = primary.connection.startupScriptReadyText;
  }
  tab.sessionId = active?.sessionId ?? null;
  tab.runtimeInstanceId = active?.runtimeInstanceId ?? null;
  tab.connected = tab.panes.some((pane) => pane.connected);
  tab.title = active?.title ?? tab.title;
}

function buildTab(
  id: string,
  panes: Pane[],
  layout: PaneNode,
  activePaneId: string | null,
  title?: string
): Tab {
  const tab: Tab = {
    id,
    title: title ?? panes[0]?.title ?? "Session",
    host: "",
    port: 22,
    auth: { username: "", method: { type: "password", password: "" } },
    sessionId: null,
    connected: false,
    panes,
    layout,
    activePaneId: activePaneId ?? panes[0]?.id ?? null,
  };
  syncTabFromPanes(tab);
  return tab;
}

function loadV2State(parsed: Partial<PersistedTabsStateV2>): PersistedTabsStateV2 | null {
  const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
  const tabs: Tab[] = [];
  for (const rawTab of rawTabs) {
    if (!rawTab || typeof rawTab.id !== "string") continue;
    const rawPanes = Array.isArray(rawTab.panes) ? rawTab.panes : [];
    const panes: Pane[] = [];
    for (const rawPane of rawPanes) {
      const pane = validatePane(rawPane, rawTab.id as string);
      if (pane) panes.push(pane);
    }
    if (panes.length === 0) continue;
    const validIds = new Set(panes.map((pane) => pane.id));
    const layout =
      validateLayout(rawTab.layout, validIds) ?? leaf(panes[0]!.id);
    const layoutIds = new Set(collectPaneIds(layout));
    // Drop panes that survived validation but are unreachable from the
    // (possibly pruned) layout tree.
    const livePanes = panes.filter((pane) => layoutIds.has(pane.id));
    if (livePanes.length === 0) continue;
    const activePaneId =
      typeof rawTab.activePaneId === "string" &&
      layoutIds.has(rawTab.activePaneId)
        ? rawTab.activePaneId
        : collectPaneIds(layout)[0]!;
    tabs.push(buildTab(rawTab.id as string, livePanes, layout, activePaneId));
  }
  if (tabs.length === 0) return null;
  const activeTabId =
    typeof parsed.activeTabId === "string" &&
    tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : tabs[0]!.id;
  return { version: 2, tabs, activeTabId };
}

function loadLegacyState(raw: string): PersistedTabsStateV2 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedTabsStateV1>;
    const rawTabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
    const tabs: Tab[] = [];
    for (const legacy of rawTabs) {
      if (
        !legacy?.id ||
        !legacy.host ||
        !legacy.port ||
        !legacy.auth
      ) {
        continue;
      }
      const method = legacy.auth.method;
      if (method.type === "key" && !method.key_id) {
        // Legacy tabs holding key paths instead of uploaded key ids cannot
        // connect; keep discarding them (see "discard legacy key-path tabs").
        continue;
      }
      if (
        method.type === "stored_password" &&
        (!legacy.connectionId ||
          method.connection_id !== legacy.connectionId)
      ) {
        continue;
      }
      const connection: PaneConnection = {
        host: legacy.host,
        port: legacy.port,
        auth: makePersistableAuth(
          legacy.auth,
          legacy.connectionId,
          Boolean(legacy.canRestorePassword)
        ),
        connectionId: legacy.connectionId,
        canRestorePassword: legacy.canRestorePassword,
        startupScript: legacy.startupScript,
        startupScriptReadyText: legacy.startupScriptReadyText,
      };
      const tabId = legacy.id as string;
      const pane = makePane(tabId, connection, tabId);
      pane.sessionId =
        typeof legacy.sessionId === "string" ? legacy.sessionId : null;
      pane.runtimeInstanceId =
        typeof legacy.runtimeInstanceId === "string"
          ? legacy.runtimeInstanceId
          : null;
      if (!canPersistPane(pane)) continue;
      tabs.push(buildTab(tabId, [pane], leaf(pane.id), pane.id));
    }
    if (tabs.length === 0) return null;
    const activeTabId =
      typeof parsed.activeTabId === "string" &&
      tabs.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[0]!.id;
    return { version: 2, tabs, activeTabId };
  } catch {
    return null;
  }
}

function loadPersistedState(): PersistedTabsStateV2 {
  const empty: PersistedTabsStateV2 = {
    version: 2,
    tabs: [],
    activeTabId: null,
  };
  if (!canUseStorage()) return empty;

  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      const state = loadV2State(JSON.parse(rawV2));
      if (state) return state;
    }
    const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (rawV1) {
      const state = loadLegacyState(rawV1);
      if (state) return state;
    }
    return empty;
  } catch {
    return empty;
  }
}

function persistState(tabs: Tab[], activeTabId: string | null) {
  if (!canUseStorage()) return;

  const persistableTabs: Tab[] = [];
  for (const tab of tabs) {
    const alivePanes = tab.panes.filter(canPersistPane).map((pane) => {
      const { preserveSessionOnMove: _transient, ...cleanPane } = pane;
      return {
        ...cleanPane,
        connection: {
          ...pane.connection,
          auth: makePersistableAuth(
            pane.connection.auth,
            pane.connection.connectionId,
            Boolean(pane.connection.canRestorePassword)
          ),
        },
        connected: false,
      };
    });
    if (alivePanes.length === 0) continue;
    const aliveIds = new Set(alivePanes.map((pane) => pane.id));
    const layout = pruneLayout(tab.layout, aliveIds);
    if (!layout) continue;
    const layoutIds = collectPaneIds(layout);
    const activePaneId = aliveIds.has(tab.activePaneId ?? "")
      ? tab.activePaneId
      : layoutIds[0]!;
    const synced = buildTab(
      tab.id,
      tab.panes,
      layout,
      activePaneId,
      tab.title
    );
    synced.panes = alivePanes;
    syncTabFromPanes(synced);
    persistableTabs.push(synced);
  }

  const persistableActiveTabId =
    activeTabId && persistableTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : persistableTabs[0]?.id ?? null;

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      tabs: persistableTabs,
      activeTabId: persistableActiveTabId,
    } satisfies PersistedTabsStateV2)
  );
}

function createTabsStore() {
  const initialState = loadPersistedState();
  let tabs = $state<Tab[]>(initialState.tabs);
  let activeTabId = $state<string | null>(initialState.activeTabId);

  function commit() {
    persistState(tabs, activeTabId);
  }

  function getPaneOrNull(tabId: string, paneId: string): Pane | undefined {
    return tabs
      .find((tab) => tab.id === tabId)
      ?.panes.find((pane) => pane.id === paneId);
  }

  function mutateTab(tabId: string, mutate: (tab: Tab) => void) {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    mutate(tab);
    syncTabFromPanes(tab);
    tabs = [...tabs];
    commit();
  }

  /**
   * Apply a layout mutation while keeping live SSH sessions alive. Any pane
   * of the involved tabs may unmount and remount as the tree reshapes, so
   * every Terminal gets the disconnectOnDestroy opt-out for the duration and
   * re-attaches through its persisted sessionId afterwards. Actions are
   * serialized so concurrent mutations cannot clear each other's flags.
   */
  let layoutQueue: Promise<unknown> = Promise.resolve();

  async function withPreservedLayout(
    involvedTabIds: string[],
    mutate: () => void
  ) {
    const run = layoutQueue.then(async () => {
      const involved = new Set(involvedTabIds);
      for (const tab of tabs) {
        if (!involved.has(tab.id)) continue;
        for (const pane of tab.panes) {
          pane.preserveSessionOnMove = true;
        }
      }
      await tick();
      try {
        mutate();
      } finally {
        await tick();
        // Panes may have been copied into other tabs by the mutation, so
        // clear the transient flag across the whole store instead of
        // tracked refs.
        for (const tab of tabs) {
          for (const pane of tab.panes) {
            if (pane.preserveSessionOnMove) {
              pane.preserveSessionOnMove = false;
            }
          }
        }
        tabs = [...tabs];
        commit();
      }
    });
    layoutQueue = run.then(
      () => undefined,
      () => undefined
    );
    await run;
  }

  return {
    get tabs() {
      return tabs;
    },

    get activeTabId() {
      return activeTabId;
    },

    get activeTab(): Tab | undefined {
      return tabs.find((tab) => tab.id === activeTabId);
    },

    getTab(id: string): Tab | undefined {
      return tabs.find((tab) => tab.id === id);
    },

    getPane(tabId: string, paneId: string): Pane | undefined {
      return getPaneOrNull(tabId, paneId);
    },

    getActivePane(tabId?: string): Pane | undefined {
      const tab = tabId
        ? tabs.find((candidate) => candidate.id === tabId)
        : this.activeTab;
      if (!tab) return undefined;
      return (
        tab.panes.find((pane) => pane.id === tab.activePaneId) ??
        tab.panes[0]
      );
    },

    addTab(
      host: string,
      port: number,
      auth: AuthConfig,
      connectionId?: string,
      canRestorePassword = false,
      startupScript?: string,
      startupScriptReadyText?: string
    ): string {
      const id = crypto.randomUUID();
      const connection: PaneConnection = {
        host,
        port,
        auth,
        connectionId,
        canRestorePassword,
        startupScript,
        startupScriptReadyText,
      };
      const pane = makePane(id, connection);
      const tab = buildTab(id, [pane], leaf(pane.id), pane.id);

      tabs = [...tabs, tab];
      activeTabId = id;
      commit();

      return id;
    },

    removeTab(id: string) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;

      tabs = tabs.filter((tab) => tab.id !== id);

      if (activeTabId === id) {
        if (tabs.length > 0) {
          const newIndex = Math.min(index, tabs.length - 1);
          activeTabId = tabs[newIndex].id;
        } else {
          activeTabId = null;
        }
      }

      commit();
    },

    setActiveTab(id: string) {
      if (tabs.some((tab) => tab.id === id)) {
        activeTabId = id;
        commit();
      }
    },

    moveTab(id: string, toIndex: number) {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const clamped = Math.min(Math.max(toIndex, 0), tabs.length - 1);
      if (clamped === index) return;
      const reordered = [...tabs];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(clamped, 0, moved!);
      tabs = reordered;
      commit();
    },

    setConnected(
      id: string,
      sessionId: string,
      runtimeInstanceId?: string | null
    ) {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      const paneId = tab.activePaneId ?? tab.panes[0]?.id;
      if (!paneId) return;
      this.setPaneConnected(id, paneId, sessionId, runtimeInstanceId);
    },

    setDisconnected(id: string) {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      for (const pane of [...tab.panes]) {
        this.setPaneDisconnected(id, pane.id);
      }
    },

    setActivePane(tabId: string, paneId: string) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (!tab.panes.some((pane) => pane.id === paneId)) return;
      mutateTab(tabId, (candidate) => {
        candidate.activePaneId = paneId;
      });
    },

    setPaneConnected(
      tabId: string,
      paneId: string,
      sessionId: string,
      runtimeInstanceId?: string | null
    ) {
      mutateTab(tabId, (tab) => {
        const pane = tab.panes.find((candidate) => candidate.id === paneId);
        if (!pane) return;
        pane.sessionId = sessionId;
        pane.runtimeInstanceId = runtimeInstanceId ?? null;
        pane.connected = true;
      });
    },

    setPaneDisconnected(tabId: string, paneId: string) {
      mutateTab(tabId, (tab) => {
        const pane = tab.panes.find((candidate) => candidate.id === paneId);
        if (!pane) return;
        pane.sessionId = null;
        pane.runtimeInstanceId = null;
        pane.connected = false;
      });
    },

    /** Split a pane in the given direction, cloning its connection target. */
    async splitPane(
      tabId: string,
      paneId: string,
      dir: "row" | "col"
    ): Promise<string | null> {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return null;
      const source = tab.panes.find((candidate) => candidate.id === paneId);
      if (!source) return null;

      const connection: PaneConnection = {
        ...source.connection,
        auth: { ...source.connection.auth },
      };
      const pane = makePane(tabId, connection);
      let newPaneId: string | null = null;

      await withPreservedLayout([tabId], () => {
        const target = tabs.find((candidate) => candidate.id === tabId);
        if (!target) return;
        target.panes = [...target.panes, pane];
        target.layout = replaceLeaf(target.layout, paneId, (leafNode) =>
          makeSplit(dir, 0.5, [leafNode, leaf(pane.id)])
        );
        target.activePaneId = pane.id;
        syncTabFromPanes(target);
        newPaneId = pane.id;
      });
      return newPaneId;
    },

    /** Close a pane; closes the tab when it holds the last pane. */
    async closePane(tabId: string, paneId: string) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (!tab.panes.some((pane) => pane.id === paneId)) return;

      const remaining = tab.panes.filter((pane) => pane.id !== paneId);
      if (remaining.length === 0) {
        this.removeTab(tabId);
        return;
      }

      await withPreservedLayout([tabId], () => {
        const candidate = tabs.find((entry) => entry.id === tabId);
        if (!candidate) return;
        candidate.panes = candidate.panes.filter(
          (pane) => pane.id !== paneId
        );
        const pruned = pruneLayout(
          candidate.layout,
          new Set(candidate.panes.map((pane) => pane.id))
        );
        candidate.layout = pruned ?? leaf(candidate.panes[0]!.id);
        const stillAlive = collectPaneIds(candidate.layout);
        if (!stillAlive.includes(candidate.activePaneId ?? "")) {
          candidate.activePaneId = stillAlive[0] ?? null;
        }
        syncTabFromPanes(candidate);
      });
    },

    /**
     * Merge the source tab's whole pane tree into the target tab as a split.
     * Panes keep their own connection targets, so different servers can sit
     * side by side. The source tab is removed.
     */
    async mergeTab(
      sourceTabId: string,
      targetTabId: string,
      dir: "row" | "col",
      side: "before" | "after"
    ) {
      if (sourceTabId === targetTabId) return;
      const source = tabs.find((candidate) => candidate.id === sourceTabId);
      const target = tabs.find((candidate) => candidate.id === targetTabId);
      if (!source || !target) return;

      const movedPanes = source.panes.map((pane) => ({
        ...pane,
        tabId: targetTabId,
      }));

      const mergedLayout = makeSplit(dir, 0.5, [
        side === "before" ? source.layout : target.layout,
        side === "before" ? target.layout : source.layout,
      ]);

      await withPreservedLayout([sourceTabId, targetTabId], () => {
        const destination = tabs.find(
          (candidate) => candidate.id === targetTabId
        );
        if (!destination) return;
        destination.panes = [...destination.panes, ...movedPanes];
        destination.layout = mergedLayout;
        destination.activePaneId = movedPanes[0]?.id ?? destination.activePaneId;
        syncTabFromPanes(destination);

        tabs = tabs.filter((candidate) => candidate.id !== sourceTabId);
        if (activeTabId === sourceTabId) {
          activeTabId = targetTabId;
        }
      });
      commit();
    },

    updateSplitRatio(tabId: string, splitId: string, ratio: number) {
      mutateTab(tabId, (tab) => {
        tab.layout = updateRatio(tab.layout, splitId, ratio);
      });
    },

    /** Move a pane next to another pane of the same tab (drag rearrange). */
    async movePaneWithinTab(
      tabId: string,
      paneId: string,
      targetPaneId: string,
      dir: "row" | "col",
      side: "before" | "after"
    ) {
      if (paneId === targetPaneId) return;
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (
        !tab.panes.some((pane) => pane.id === paneId) ||
        !tab.panes.some((pane) => pane.id === targetPaneId)
      ) {
        return;
      }

      await withPreservedLayout([tabId], () => {
        const candidate = tabs.find((entry) => entry.id === tabId);
        if (!candidate) return;
        const withoutMoved = pruneLayout(
          candidate.layout,
          new Set(
            collectPaneIds(candidate.layout).filter((id) => id !== paneId)
          )
        );
        if (!withoutMoved) return;
        candidate.layout = replaceLeaf(
          withoutMoved,
          targetPaneId,
          (leafNode) =>
            makeSplit(
              dir,
              0.5,
              side === "before"
                ? [leaf(paneId), leafNode]
                : [leafNode, leaf(paneId)]
            )
        );
        candidate.activePaneId = paneId;
        syncTabFromPanes(candidate);
      });
    },
  };
}

export const tabsStore = createTabsStore();
