"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { usePathname } from "next/navigation";

import {
  getSessionToken,
  hasActiveCachedSession,
  isAbortError,
  reportClientError,
  reportClientPerformance,
} from "./lib/auth";

export default function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoginPage) return;
    // The Android shell may be launched from the locally bundled fallback
    // after its configured TMS server is unreachable.  That local origin does
    // not share the live site's session storage, but it can still read the
    // device-owned offline catalog.  Let the Offline section render.
    const nativeLocalFallback = Capacitor.isNativePlatform()
      && (window.location.pathname === "/index.html" || ["localhost", "127.0.0.1"].includes(window.location.hostname));
    if (nativeLocalFallback && !getSessionToken()) {
      // A build with no online server configured launches from Capacitor's
      // local origin. Start in Offline immediately instead of demanding a
      // login for a server the app deliberately does not have.
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== "offline") {
        url.searchParams.set("section", "offline");
        window.history.replaceState(null, "", `${url.pathname}${url.search}`);
      }
      setReady(true);
      return;
    }
    if (hasActiveCachedSession()) {
      setReady(true);
      reportClientPerformance("protected_page_ready", performance.now(), { session_source: "cache" });
      return;
    }
    if (!getSessionToken()) {
      // The native fallback can retain the configured server origin even
      // though its document came from the APK. In that case there is no
      // browser session to restore, but a disconnected server must not turn
      // the device-owned Offline library into a login screen.
      if (Capacitor.isNativePlatform()) {
        let cancelled = false;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 3_000);
        const openOfflineIfUnavailable = async () => {
          try {
            const response = await fetch("/api/health", {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Server returned ${response.status}`);
            if (!cancelled) window.location.replace("/login");
          } catch {
            if (cancelled) return;
            const url = new URL(window.location.href);
            url.searchParams.set("section", "offline");
            window.history.replaceState(null, "", `${url.pathname}${url.search}`);
            setReady(true);
          } finally {
            window.clearTimeout(timeout);
          }
        };
        void openOfflineIfUnavailable();
        return () => {
          cancelled = true;
          controller.abort();
          window.clearTimeout(timeout);
        };
      }
      window.location.replace("/login");
      return;
    }
    // A credential without a cached user is invalid local state.
    window.location.replace("/login");
  }, [isLoginPage]);

  useEffect(() => {
    if (isLoginPage || !getSessionToken()) return;
    const onError = (event: ErrorEvent) => {
      if (isAbortError(event.error)) return;
      reportClientError(event.error ?? event.message, {
        kind: "window-error",
        source: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isAbortError(event.reason)) {
        event.preventDefault();
        return;
      }
      const stack = event.reason instanceof Error ? event.reason.stack ?? "" : "";
      const extensionFetchFailure = event.reason instanceof TypeError
        && event.reason.message === "Failed to fetch"
        && stack.includes("chrome-extension://");
      if (extensionFetchFailure) event.preventDefault();
      reportClientError(event.reason, { kind: "unhandled-promise-rejection" });
    };
    const originalConsoleError = console.error;
    const loggedConsoleError = (...args: unknown[]) => {
      originalConsoleError.apply(console, args);
      const error = args.find((value) => value instanceof Error) ?? args.map((value) => String(value)).join(" ");
      if (isAbortError(error)) return;
      reportClientError(error, { kind: "console-error" });
    };
    console.error = loggedConsoleError;
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    // Android reopens the page with this marker after its WebView renderer dies,
    // because that crash leaves no JavaScript alive to report it.
    const recoveredUrl = new URL(window.location.href);
    const rendererGone = recoveredUrl.searchParams.get("rendererGone");
    if (rendererGone) {
      reportClientError(new Error(`Android WebView renderer gone: ${rendererGone}`), { kind: "android-renderer-gone" });
      recoveredUrl.searchParams.delete("rendererGone");
      window.history.replaceState(window.history.state, "", recoveredUrl);
    }
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      if (console.error === loggedConsoleError) console.error = originalConsoleError;
    };
  }, [isLoginPage]);

  if (isLoginPage) return children;
  if (!ready) return <main className="auth-loading" />;
  return children;
}
