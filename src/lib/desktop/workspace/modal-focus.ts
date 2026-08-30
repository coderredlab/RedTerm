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

function focusableElements(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0
  );
}

export function modalFocus(node: HTMLElement, initialOptions: ModalFocusOptions) {
  let options = initialOptions;
  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const inertSiblings = Array.from(node.parentElement?.children ?? [])
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== node)
    .map((element) => ({ element, inert: element.inert }));

  for (const { element } of inertSiblings) {
    element.inert = true;
  }

  function focusInitialElement() {
    const requested = node.querySelector<HTMLElement>("[data-modal-initial-focus]");
    const first = focusableElements(node)[0];
    (requested ?? first ?? node).focus({ preventScroll: true });
  }

  function handleKeydown(event: KeyboardEvent) {
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

  document.addEventListener("keydown", handleKeydown, true);
  queueMicrotask(focusInitialElement);

  return {
    update(nextOptions: ModalFocusOptions) {
      options = nextOptions;
    },
    destroy() {
      document.removeEventListener("keydown", handleKeydown, true);
      for (const { element, inert } of inertSiblings) {
        element.inert = inert;
      }
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    },
  };
}
