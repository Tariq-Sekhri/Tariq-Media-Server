// These public poster hosts do not all expose CORS headers. Relay only known
// providers so browser and Android clients can persist their image bytes.
export const dynamic = "force-dynamic";
const HOSTS = new Set(["images.metahub.space", "image.tmdb.org"]);
const MAX_BYTES = 10 * 1024 * 1024;

export async function GET(request: Request) {
  let source: URL;
  try {
    source = new URL(new URL(request.url).searchParams.get("url") ?? "");
    if (source.protocol !== "https:" || !HOSTS.has(source.hostname) || source.port || source.username || source.password) throw new Error("Invalid host");
  } catch {
    return new Response("Unsupported artwork URL", { status: 400 });
  }
  try {
    const upstream = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("image/") || !upstream.body) {
      await upstream.body?.cancel();
      return new Response("Artwork unavailable", { status: 502 });
    }
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return new Response("Artwork too large", { status: 502 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  } catch {
    return new Response("Artwork unavailable", { status: 502 });
  }
}
