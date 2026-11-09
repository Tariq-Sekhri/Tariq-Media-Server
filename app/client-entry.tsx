// Client-only entry for the shared screens when no RSC server is reachable.
import { createRoot } from "react-dom/client";
import Home from "./page";
import Watch from "./watch/page";
import Login from "./login/page";
import Admin from "./admin/page";
import AuthGate from "./AuthGate";
import ModalIsolation from "./ModalIsolation";
import CapacitorAppListener from "./CapacitorAppListener";
import PwaServiceWorker from "./PwaServiceWorker";
import PlaybackProvider from "./PlaybackProvider";
import AppShell from "./AppShell";
import AppConfirmProvider from "./AppConfirmProvider";
import "./globals.css";
import "./unified.css";
import "./watch-player-controls.css";

const url = new URL(window.location.href);
if (url.pathname === "/index.html" || url.pathname === "/offline.html") {
  url.pathname = "/";
  if (!url.searchParams.has("section")) url.searchParams.set("section", "offline");
  window.history.replaceState(null, "", url.pathname + url.search);
}
const Page = url.pathname === "/watch" ? Watch : url.pathname === "/login" ? Login : url.pathname === "/admin" ? Admin : Home;
createRoot(document.getElementById("root")!).render(<><ModalIsolation /><CapacitorAppListener /><AuthGate><AppConfirmProvider><PlaybackProvider><AppShell><Page /></AppShell></PlaybackProvider></AppConfirmProvider></AuthGate><PwaServiceWorker /></>);
