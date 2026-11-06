"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("TMS page failed to render", error);
  }, [error]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#0d1013", color: "#edf1f3", fontFamily: "Arial, sans-serif" }}>
      <section style={{ width: "min(520px, 100%)", border: "1px solid #3a424a", borderRadius: 14, padding: 28, background: "#151a1f", boxShadow: "0 20px 70px #0008" }}>
        <p style={{ margin: "0 0 8px", color: "#ed8b92", fontWeight: 800, letterSpacing: ".08em", fontSize: 12, textTransform: "uppercase" }}>TMS needs attention</p>
        <h1 style={{ margin: "0 0 10px", fontSize: 24 }}>This page could not load</h1>
        <p style={{ margin: "0 0 22px", color: "#b7c0c7", lineHeight: 1.55 }}>TMS kept the error visible instead of showing a blank page. The tray icon will show whether the media server is rebuilding or has a build error.</p>
        <button type="button" onClick={reset} style={{ border: "1px solid #8b76f0", borderRadius: 8, padding: "10px 14px", background: "#6d58cc", color: "white", fontWeight: 750, cursor: "pointer" }}>Try again</button>
      </section>
    </main>
  );
}
