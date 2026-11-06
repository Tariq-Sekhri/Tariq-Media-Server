"use client";

import { useEffect } from "react";

/** Isolate the topmost modal, including dialogs rendered inside the app shell. */
export default function ModalIsolation() {
  useEffect(() => {
    let active: HTMLElement | null = null;
    let returnFocus: HTMLElement | null = null;
    let scrollY = 0;
    let previousOverflow = "";
    let previousPosition = "";
    let previousTop = "";
    let previousWidth = "";
    const hidden = new Map<HTMLElement, { inert: boolean; aria: string | null }>();
    const restore = () => {
      hidden.forEach((state, element) => {
        element.inert = state.inert;
        if (state.aria === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", state.aria);
      });
      hidden.clear();
    };
    const update = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], .account-popover, .folder-context-menu, .folder-create-modal, .profile-settings-modal')].filter(el => el.getClientRects().length);
      const next = dialogs.at(-1) ?? null;
      restore();
      if (next !== active) {
        if (!active && next) {
          returnFocus = document.activeElement as HTMLElement;
          scrollY = window.scrollY;
          previousOverflow = document.body.style.overflow;
          previousPosition = document.body.style.position;
          previousTop = document.body.style.top;
          previousWidth = document.body.style.width;
          document.body.style.overflow = "hidden";
          document.body.style.position = "fixed";
          document.body.style.top = `-${scrollY}px`;
          document.body.style.width = "100%";
        }
        if (active && !next) {
          document.body.style.overflow = previousOverflow;
          document.body.style.position = previousPosition;
          document.body.style.top = previousTop;
          document.body.style.width = previousWidth;
          window.scrollTo(0, scrollY);
        }
        active = next;
        if (next) {
          next.tabIndex = -1;
          next.focus({ preventScroll: true });
        } else if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }
      if (!next) return;
      next.setAttribute("role", "dialog");
      next.setAttribute("aria-modal", "true");
      if (!next.hasAttribute("aria-label") && !next.hasAttribute("aria-labelledby")) next.setAttribute("aria-label", next.querySelector("h2,b")?.textContent || "Actions");
      let branch: HTMLElement = next;
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
          hidden.set(sibling, { inert: sibling.inert, aria: sibling.getAttribute("aria-hidden") });
          sibling.inert = true;
          sibling.setAttribute("aria-hidden", "true");
        }
        branch = branch.parentElement;
        if (branch === document.body) break;
      }
    };
    const trapFocus = (event: FocusEvent) => {
      if (active && !active.contains(event.target as Node)) active.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusin", trapFocus);
    update();
    return () => { observer.disconnect(); document.removeEventListener("focusin", trapFocus); restore(); };
  }, []);
  return null;
}
