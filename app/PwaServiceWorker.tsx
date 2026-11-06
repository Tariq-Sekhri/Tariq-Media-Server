"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

export default function PwaServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (Capacitor.isNativePlatform()) {
      // Android carries the React entry in its APK; retire the old static worker.
      void navigator.serviceWorker.getRegistrations().then(registrations =>
        Promise.all(registrations.map(registration => registration.unregister())));
      return;
    }
    void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
  }, []);

  return null;
}
