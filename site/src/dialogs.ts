// The agreement and privacy policy dialogs. Native <dialog> handles focus trapping and Escape;
// this adds open/close wiring, returns focus to whatever opened it, and lets the agreement's
// "I agree" tick the form's checkbox.

function wireDialog(dialogId: string, openAttribute: string): HTMLDialogElement | null {
  const dialog = document.querySelector<HTMLDialogElement>(`#${dialogId}`);
  if (!dialog) return null;
  let opener: HTMLElement | null = null;

  for (const button of document.querySelectorAll<HTMLElement>(`[${openAttribute}]`)) {
    button.addEventListener("click", () => {
      opener = button;
      dialog.showModal();
      dialog.querySelector<HTMLElement>(".dialog__body")?.scrollTo({ top: 0 });
      dialog.querySelector<HTMLElement>(".dialog__body")?.focus({ preventScroll: true });
    });
  }

  dialog.addEventListener("close", () => {
    opener?.focus();
    opener = null;
  });
  // Clicking the dimmed backdrop closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  for (const button of dialog.querySelectorAll<HTMLElement>("[data-close-dialog]")) {
    button.addEventListener("click", () => dialog.close());
  }
  // Lets a caller move focus somewhere else once the dialog closes.
  dialog.addEventListener("hexenbane:refocus", (event) => {
    opener = (event as CustomEvent<HTMLElement | null>).detail;
  });
  return dialog;
}

export function initDialogs(): void {
  wireDialog("privacy-dialog", "data-open-privacy");
  const dialog = wireDialog("agreement-dialog", "data-open-agreement");
  if (!dialog) return;
  dialog.querySelector<HTMLElement>("[data-accept-agreement]")?.addEventListener("click", () => {
    const box = document.querySelector<HTMLInputElement>("#agreementAccepted");
    if (box && !box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Land on the checkbox so the choice is visible and reversible.
    dialog.dispatchEvent(new CustomEvent("hexenbane:refocus", { detail: box }));
    dialog.close();
  });
}
