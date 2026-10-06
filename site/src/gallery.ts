// Screenshot lightbox. Without JavaScript the thumbnails are plain links to the full images.

export function initGallery(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-gallery-index]"));
  const box = document.querySelector<HTMLDialogElement>("#lightbox");
  if (!links.length || !box) return;
  const img = box.querySelector<HTMLImageElement>("[data-lightbox-img]")!;
  const caption = box.querySelector<HTMLElement>("[data-lightbox-caption]")!;
  let index = 0;
  let opener: HTMLElement | null = null;

  const show = (i: number) => {
    index = (i + links.length) % links.length;
    const link = links[index];
    const thumb = link.querySelector("img");
    img.src = link.href;
    img.alt = thumb?.alt ?? "";
    caption.textContent = `${link.dataset.caption ?? ""}  ·  ${index + 1} / ${links.length}`;
  };

  links.forEach((link, i) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      opener = link;
      show(i);
      box.showModal();
    }),
  );
  box.querySelector("[data-lightbox-prev]")?.addEventListener("click", () => show(index - 1));
  box.querySelector("[data-lightbox-next]")?.addEventListener("click", () => show(index + 1));
  box.querySelector("[data-close-dialog]")?.addEventListener("click", () => box.close());
  box.addEventListener("click", (event) => {
    if (event.target === box) box.close();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") show(index - 1);
    if (event.key === "ArrowRight") show(index + 1);
  });
  box.addEventListener("close", () => opener?.focus());
}
