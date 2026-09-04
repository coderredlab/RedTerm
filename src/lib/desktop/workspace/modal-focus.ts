const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ModalFocusOptions {
  onClose: () => void;
}

interface ModalStackEntry {
  node: HTMLElement;
  options: ModalFocusOptions;
  siblingElements: HTMLElement[];
}

// Stacked so only the top-most modal reacts to Escape/Tab and inert state
// survives a nested modal (e.g. the update progress dialog) closing first.
const modalStack: ModalStackEntry[] = [];
let documentListenerAttached = false;

// Refcounted inert ownership: nested modals can share the same siblings, so
// the original value is restored only when the last owner releases.
const inertOwners = new Map<HTMLElement, { baseline: boolean; owners: number }>();

function acquireInert(element: HTMLElement) {
  const entry = inertOwners.get(element);
  if (entry) {
    entry.owners += 1;
  } else {
    inertOwners.set(element, { baseline: element.inert, owners: 1 });
  }
  element.inert = true;
}

function releaseInert(element: HTMLElement) {
  const entry = inertOwners.get(element);
  if (!entry) return;
  entry.owners -= 1;
  if (entry.owners <= 0) {
    element.inert = entry.baseline;
    inertOwners.delete(element);
  }
}

function topEntry(): ModalStackEntry | undefined {
  return modalStack[modalStack.length - 1];
}

function focusableElements(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0
  );
}

function handleDocumentKeydown(event: KeyboardEvent) {
  const entry = topEntry();
  if (!entry) return;
  const { node, options } = entry;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    options.onClose();
    return;
  }

  if (event.key !== "Tab") return;

  const focusable = focusableElements(node);
  if (focusable.length === 0) {
    event.preventDefault();
    node.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !node.contains(active))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (active === last || !node.contains(active))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function attachDocumentListener() {
  if (documentListenerAttached) return;
  document.addEventListener("keydown", handleDocumentKeydown, true);
  documentListenerAttached = true;
}

function maybeDetachDocumentListener() {
  if (modalStack.length === 0 && documentListenerAttached) {
    document.removeEventListener("keydown", handleDocumentKeydown, true);
    documentListenerAttached = false;
  }
}

function syncStackZIndexes() {
  // Keep visual stacking order in sync with the stack so the modal that owns
  // Escape/Tab is always the one rendered on top.
  for (let index = 0; index < modalStack.length; index++) {
    modalStack[index].node.style.zIndex = String(100 + index);
  }
}

export function modalFocus(node: HTMLElement, initialOptions: ModalFocusOptions) {
  let options = initialOptions;
  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const siblingElements = Array.from(node.parentElement?.children ?? [])
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== node);

  for (const element of siblingElements) {
    acquireInert(element);
  }

  const entry: ModalStackEntry = { node, options, siblingElements };
  modalStack.push(entry);
  attachDocumentListener();
  syncStackZIndexes();
  queueMicrotask(focusInitialElement);

  function focusInitialElement() {
    const requested = node.querySelector<HTMLElement>("[data-modal-initial-focus]");
    const first = focusableElements(node)[0];
    (requested ?? first ?? node).focus({ preventScroll: true });
  }

  return {
    update(nextOptions: ModalFocusOptions) {
      options = nextOptions;
      entry.options = nextOptions;
    },
    destroy() {
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      syncStackZIndexes();

      for (const element of siblingElements) {
        releaseInert(element);
      }

      if (modalStack.length === 0) {
        maybeDetachDocumentListener();
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus({ preventScroll: true });
        }
        return;
      }

      // A parent modal is still open: hand focus back into it instead of a
      // detached element.
      const parent = topEntry();
      if (parent === undefined) return;
      const focusAlreadyInsideParent =
        document.activeElement instanceof HTMLElement &&
        parent.node.contains(document.activeElement);
      if (!focusAlreadyInsideParent && parent.node.isConnected) {
        parent.node.focus({ preventScroll: true });
      }
    },
  };
}
