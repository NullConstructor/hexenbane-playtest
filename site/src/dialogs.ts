// The agreement dialog. Native <dialog> handles focus trapping and Escape; this adds open/close
// wiring, returns focus to whatever opened it, and lets "I agree" tick the form's checkbox.

export function initDialogs(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#agreement-dialog");
  if (!dialog) return;
  let opener: HTMLElement | null = null;

  for (const button of document.querySelectorAll<HTMLElement>("[data-open-agreement]")) {
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
  dialog.querySelector<HTMLElement>("[data-accept-agreement]")?.addEventListener("click", () => {
    const box = document.querySelector<HTMLInputElement>("#agreementAccepted");
    if (box && !box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Land on the checkbox so the choice is visible and reversible.
    opener = box;
    dialog.close();
  });
}
