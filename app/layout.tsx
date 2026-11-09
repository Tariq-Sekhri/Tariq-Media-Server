import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./unified.css";
import "./watch-player-controls.css";
import ModalIsolation from "./ModalIsolation";
import AuthGate from "./AuthGate";
import PwaServiceWorker from "./PwaServiceWorker";
import CapacitorAppListener from "./CapacitorAppListener";
import ProductionReleaseReloader from "./ProductionReleaseReloader";
import PlaybackProvider from "./PlaybackProvider";
import AppShell from "./AppShell";
import AppConfirmProvider from "./AppConfirmProvider";

export const metadata: Metadata = {
  title: "TMS — Tariq’s Media Server",
  description: "TMS is Tariq’s private media server.",
  applicationName: "TMS",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
    apple: "/pwa-apple-touch-icon.png",
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "TMS" },
};

export const viewport: Viewport = {
  themeColor: "#121019",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body suppressHydrationWarning><ModalIsolation /><CapacitorAppListener /><AuthGate><AppConfirmProvider><PlaybackProvider><AppShell>{children}</AppShell></PlaybackProvider></AppConfirmProvider></AuthGate><PwaServiceWorker /><ProductionReleaseReloader /></body></html>;
}
