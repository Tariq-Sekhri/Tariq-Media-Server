/** Write PNG pixels, rather than the image's URL or HTML, to the clipboard. */
export function copyNoteImage(image: HTMLImageElement): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return Promise.reject(new Error("Copy image requires HTTPS or localhost in this browser."));
  }
  const png = new Promise<Blob>((resolve, reject) => {
    try {
      if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
        throw new Error("Wait for the image to finish loading, then try again.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not copy the image.");
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not copy the image.")), "image/png");
    } catch (error) { reject(error); }
  });
  void png.catch(() => undefined);
  // Start the clipboard write during the click, preserving user activation
  // even on browsers where PNG encoding completes asynchronously.
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function noteImageForCopy(editor: HTMLElement, selected: HTMLImageElement | null, selection: Selection | null): HTMLImageElement | null {
  if (!selection) return null;
  if (!selection.isCollapsed) {
    const image = Array.from(editor.querySelectorAll("img")).find((image) => selection.containsNode(image, true));
    if (image) return image;
  }
  return selected && editor.contains(selected) && !selection.toString() ? selected : null;
}

export function selectNoteImage(editor: HTMLElement, image: HTMLImageElement | null) {
  editor.querySelectorAll("img.notes-image-selected").forEach((node) => node.classList.remove("notes-image-selected"));
  if (!image) return;
  image.classList.add("notes-image-selected");
  editor.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNode(image);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function noteHtmlWithoutImageSelection(editor: HTMLElement): string {
  const snapshot = editor.cloneNode(true) as HTMLElement;
  snapshot.querySelectorAll("img.notes-image-selected").forEach((node) => {
    node.classList.remove("notes-image-selected");
    if (!node.className) node.removeAttribute("class");
  });
  return snapshot.innerHTML;
}
