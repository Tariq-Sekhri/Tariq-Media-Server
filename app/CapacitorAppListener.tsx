"use client";

import { useEffect, useRef } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { usePathname, useRouter } from "next/navigation";
import { handleWatchBack } from "./lib/app-shell";
import { closeTopBackLayer } from "./lib/back-layers";

export default function CapacitorAppListener() {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const listener = App.addListener("backButton", ({ canGoBack }) => {
      // Full-screen Watch shrinks into the mini player, even when it was the
      // first page opened and there is no history to go back to.
      // An open menu, drawer or dialog closes before the page changes.
      if (closeTopBackLayer()) return;
      if (handleWatchBack()) return;
      if (canGoBack) {
        router.back();
        return;
      }
      
      if (pathnameRef.current === "/" || pathnameRef.current === "/login") {
        App.exitApp();
      } else {
        router.back();
      }
    });

    return () => {
      listener.then(l => l.remove()).catch(console.error);
    };
  }, [router]);

  return null;
}
