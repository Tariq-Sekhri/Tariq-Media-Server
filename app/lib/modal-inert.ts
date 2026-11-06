export type InertState = { inert: boolean; aria: string | null };

/** Preserve original state across transitions between nested/adjacent dialogs. */
export function reconcileModalInert(hidden: Map<HTMLElement, InertState>, desired: Set<HTMLElement>) {
  for (const [element, original] of hidden) {
    if (desired.has(element)) continue;
    element.inert = original.inert;
    if (original.aria === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", original.aria);
    hidden.delete(element);
  }
  for (const element of desired) {
    if (!hidden.has(element)) hidden.set(element, { inert: element.inert, aria: element.getAttribute("aria-hidden") });
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }
}
