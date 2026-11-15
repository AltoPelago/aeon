// Modal focus management reused from aeon-website/html/assets/js/site.js.
const modalFocusState = new WeakMap();
const modalFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function modalDialog(modal) {
  return modal?.matches?.('[role="dialog"]') ? modal : modal?.querySelector?.('[role="dialog"]');
}

function modalFocusableElements(modal) {
  const dialog = modalDialog(modal);
  if (!dialog) {
    return [];
  }
  return Array.from(dialog.querySelectorAll(modalFocusableSelector))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
}

function openAccessibleModal(modal, trigger = document.activeElement, preferredFocus = null) {
  if (!modal) {
    return;
  }
  modalFocusState.set(modal, trigger instanceof HTMLElement ? trigger : null);
  modal.hidden = false;
  if (trigger instanceof HTMLElement && trigger.hasAttribute("aria-expanded")) {
    trigger.setAttribute("aria-expanded", "true");
  }
  document.body.classList.add("has-open-modal");
  window.requestAnimationFrame(() => {
    const dialog = modalDialog(modal);
    const target = preferredFocus instanceof HTMLElement
      ? preferredFocus
      : modalFocusableElements(modal)[0] ?? dialog;
    target?.focus();
  });
}

function closeAccessibleModal(modal) {
  if (!modal) {
    return;
  }
  modal.hidden = true;
  const trigger = modalFocusState.get(modal);
  if (trigger instanceof HTMLElement) {
    if (trigger.hasAttribute("aria-expanded")) {
      trigger.setAttribute("aria-expanded", "false");
    }
    trigger.focus();
  }
  modalFocusState.delete(modal);
  if (!document.querySelector('.site-search:not([hidden]), .playground-modal:not([hidden])')) {
    document.body.classList.remove("has-open-modal");
  }
}

window.AeonAccessibility = {
  openModal: openAccessibleModal,
  closeModal: closeAccessibleModal
};

document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") {
    return;
  }
  const openModals = Array.from(document.querySelectorAll('.site-search:not([hidden]), .playground-modal:not([hidden])'));
  const modal = openModals[openModals.length - 1];
  if (!modal) {
    return;
  }
  const focusable = modalFocusableElements(modal);
  if (focusable.length === 0) {
    event.preventDefault();
    modalDialog(modal)?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
