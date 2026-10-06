/** Gives the top bar a backdrop once the page scrolls past the hero's top edge. */
export function initTopbar(): void {
  const bar = document.querySelector<HTMLElement>("[data-topbar]");
  if (!bar) return;
  const update = () => bar.classList.toggle("is-scrolled", window.scrollY > 24);
  update();
  window.addEventListener("scroll", update, { passive: true });
}
