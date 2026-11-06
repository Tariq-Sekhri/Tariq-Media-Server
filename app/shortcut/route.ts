import { NextRequest } from "next/server";

const safeDestination = (value: string | null) => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
};

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

export function GET(request: NextRequest) {
  const destination = safeDestination(request.nextUrl.searchParams.get("to"));
  const suppliedName = request.nextUrl.searchParams.get("name")?.trim();
  const name = suppliedName?.slice(0, 120) || "TMS";
  const target = new URL(destination, request.url).href;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} · TMS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121019;color:#f3f1ff;font:16px system-ui,sans-serif}.card{max-width:360px;margin:24px;padding:28px;border:1px solid #3b344d;border-radius:18px;background:#1b1725;text-align:center;box-shadow:0 20px 70px #0008}h1{margin:0 0 10px;font-size:21px}p{color:#c8c2d5;line-height:1.5}b{color:#fff}a{display:inline-block;margin-top:8px;padding:12px 16px;border-radius:10px;background:#806bea;color:#fff;text-decoration:none;font-weight:700}</style>
</head><body><main class="card"><h1>Add this TMS shortcut</h1><p>In your phone browser menu, choose <b>Add to Home screen</b>. The icon will open <b>${escapeHtml(name)}</b> directly.</p><a href="${escapeHtml(target)}">Open ${escapeHtml(name)}</a></main><script>if(matchMedia('(display-mode: standalone)').matches||navigator.standalone)location.replace(${JSON.stringify(destination)});</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
