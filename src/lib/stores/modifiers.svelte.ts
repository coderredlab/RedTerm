// Modifier keys state (CTRL, ALT) - shared between ExtraKeysBar and Terminal

let ctrlActive = $state(false);
let altActive = $state(false);

export const modifiersStore = {
  get ctrlActive() { return ctrlActive; },
  get altActive() { return altActive; },

  toggleCtrl() {
    ctrlActive = !ctrlActive;
    if (ctrlActive) altActive = false;  // 하나만 활성화
  },

  toggleAlt() {
    altActive = !altActive;
    if (altActive) ctrlActive = false;
  },

  resetCtrl() {
    ctrlActive = false;
  },

  resetAlt() {
    altActive = false;
  },

  reset() {
    ctrlActive = false;
    altActive = false;
  }
};
