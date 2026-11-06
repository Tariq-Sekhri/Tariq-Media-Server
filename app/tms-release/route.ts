export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { release: process.env.TMS_FRONTEND_RELEASE_ID ?? "unknown" },
    { headers: { "cache-control": "no-store" } },
  );
}
