import { collectMarket } from "./collector.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Last-Modified, Retry-After",
};

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const url = Deno.env.get("SUPABASE_URL");
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  const key = (keys && JSON.parse(keys).default) || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || typeof key !== "string" || !key) throw Error("Missing service configuration");
  const headers = new Headers({ apikey: key, "Content-Type": "application/json" });
  // Current secret keys authenticate at the gateway via apikey. Legacy keys are JWTs.
  if (!key.startsWith("sb_secret_")) headers.set("Authorization", "Bearer " + key);
  const response = await fetch(new URL("/rest/v1/rpc/market_cache_" + name, url), {
    method: "POST", headers, body: JSON.stringify(args), redirect: "error", signal: AbortSignal.timeout(5500),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("Database RPC " + name + " returned " + response.status);
  }
  return await response.json() as T;
}

function status(code: number, extra: Record<string, string> = {}) {
  return new Response(null, { status: code, headers: { ...cors, "Cache-Control": "no-store", ...extra } });
}

type Snapshot = { revision: string; published_at: string; payload: unknown };

async function read(request: Request) {
  const head = request.method === "HEAD";
  const tags = (request.headers.get("If-None-Match") ?? "").split(",", 32)
    .map(tag => tag.trim().replace(/^W\//, ""));
  const revisions = tags.filter(tag => tag.startsWith('"') && tag.endsWith('"'))
    .map(tag => tag.slice(1, -1)).filter(value => uuid.test(value));
  const any = tags.includes("*");
  const cache = await rpc<Snapshot | null>("read", {
    p_known: revisions, p_metadata_only: head || any,
  });
  if (!cache) return status(503, { "Retry-After": "60" });
  const headers = {
    ...cors, "Cache-Control": "public, max-age=60, s-maxage=60",
    "Content-Type": "application/json; charset=utf-8",
    ETag: '"' + cache.revision + '"', "Last-Modified": new Date(cache.published_at).toUTCString(),
  };
  if (any || revisions.includes(cache.revision)) return new Response(null, { status: 304, headers });
  return new Response(head ? null : JSON.stringify(cache.payload), { headers });
}

async function refresh(request: Request) {
  const ticket = request.headers.get("x-market-refresh-token");
  if (!ticket || !uuid.test(ticket)) return status(403);
  if (!(await rpc<boolean>("acquire", { p_ticket: ticket }))) return status(403);
  try {
    const payload = await collectMarket();
    const published = await rpc<boolean>("finish", { p_ticket: ticket, p_payload: payload });
    return status(published ? 204 : 409);
  } catch (error) {
    // Preserve the last completed snapshot. An interrupted worker's lease also expires automatically.
    try { await rpc<boolean>("finish", { p_ticket: ticket, p_payload: null }); } catch { /* lease expiry */ }
    throw error;
  }
}

Deno.serve(async request => {
  try {
    switch (request.method) {
      case "OPTIONS": return status(204, { "Access-Control-Max-Age": "3600" });
      case "GET":
      case "HEAD": return await read(request);
      case "POST": return await refresh(request);
      default: return status(405, { Allow: "GET, HEAD, OPTIONS, POST" });
    }
  } catch {
    console.error("Market cache " + request.method + " failed");
    return status(503, { "Retry-After": "60" });
  }
});
