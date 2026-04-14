/**
 * Noornote Scheduler — Hold & Forward service for scheduled Nostr posts.
 *
 * Client signs an event locally with `created_at = publishAt`, sends it here.
 * We hold it in Deno KV until publishAt, then publish via WebSocket to the
 * user's relays. No private key is ever on the server.
 */

import { isValidEventShape, type SignedNostrEvent, verifyEvent } from "./verify.ts";

// Allowed browser origins. Reflect the request's Origin header when it matches
// so dev (localhost), web (noornote.app), Capacitor Android (https://localhost
// due to androidScheme:'https'), and Electron (which sends null Origin from
// file://) can all call the API.
const ALLOWED_ORIGINS = [
  "https://noornote.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "null",
];
const ALLOWED_KINDS = new Set([1, 30023]);
const MAX_RELAYS = 20;
const MAX_PENDING_PER_PUBKEY = 10;
const SCHEDULE_MIN_DELAY_S = 60;
const SCHEDULE_MAX_DELAY_S = 30 * 24 * 60 * 60; // 30 days
const KV_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const PUBLISH_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 5;

interface ScheduledRecord {
  event: SignedNostrEvent;
  relays: string[];
  publishAt: number;
  createdAt: number;
  status: "pending" | "published" | "failed";
  attempts: number;
  lastError?: string;
}

const kv = await Deno.openKv();

// ---------- Helpers ----------

function resolveOrigin(request: Request): string {
  // Electron with file:// sends Origin header literal "null" (not missing).
  const origin = request.headers.get("origin") ?? "null";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function corsHeaders(request: Request, extra: Record<string, string> = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": resolveOrigin(request),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request, { "Content-Type": "application/json" }),
  });
}

function errorResponse(request: Request, message: string, status = 400): Response {
  return jsonResponse(request, { error: message }, status);
}

function makeUlid(): string {
  // Lexicographically sortable: timestamp_ms (13 hex chars) + random (16 hex chars)
  const ts = Date.now().toString(16).padStart(13, "0");
  const rand = crypto.getRandomValues(new Uint8Array(8));
  let randHex = "";
  for (const b of rand) randHex += b.toString(16).padStart(2, "0");
  return `${ts}_${randHex}`;
}

function isValidRelayUrl(url: string): boolean {
  return typeof url === "string" &&
    (url.startsWith("wss://") || url.startsWith("ws://")) &&
    url.length < 256;
}

async function countPending(pubkey: string): Promise<number> {
  let n = 0;
  for await (const _ of kv.list({ prefix: ["scheduled", pubkey] })) n++;
  return n;
}

// ---------- Routes ----------

async function handleSchedule(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "invalid JSON body");
  }

  if (!body || typeof body !== "object") return errorResponse(request, "body must be an object");
  const { event, relays, publishAt } = body as {
    event?: unknown;
    relays?: unknown;
    publishAt?: unknown;
  };

  if (!isValidEventShape(event)) return errorResponse(request, "invalid event shape");
  if (!ALLOWED_KINDS.has(event.kind)) {
    return errorResponse(request, `kind ${event.kind} not allowed (only 1 and 30023)`);
  }

  if (!Array.isArray(relays) || relays.length === 0) {
    return errorResponse(request, "relays must be a non-empty array");
  }
  if (relays.length > MAX_RELAYS) {
    return errorResponse(request, `max ${MAX_RELAYS} relays`);
  }
  for (const r of relays) {
    if (!isValidRelayUrl(r)) return errorResponse(request, `invalid relay URL: ${r}`);
  }

  if (typeof publishAt !== "number" || !Number.isFinite(publishAt)) {
    return errorResponse(request, "publishAt must be a unix timestamp (number)");
  }
  const now = Math.floor(Date.now() / 1000);
  if (publishAt <= now + SCHEDULE_MIN_DELAY_S) {
    return errorResponse(request, `publishAt must be at least ${SCHEDULE_MIN_DELAY_S}s in the future`);
  }
  if (publishAt > now + SCHEDULE_MAX_DELAY_S) {
    return errorResponse(request, `publishAt cannot be more than 30 days in the future`);
  }
  if (publishAt !== event.created_at) {
    return errorResponse(request, "publishAt must equal event.created_at");
  }

  if (!verifyEvent(event)) return errorResponse(request, "invalid event signature");

  const pending = await countPending(event.pubkey);
  if (pending >= MAX_PENDING_PER_PUBKEY) {
    return errorResponse(request, `max ${MAX_PENDING_PER_PUBKEY} pending scheduled posts per pubkey`, 429);
  }

  const id = makeUlid();
  const record: ScheduledRecord = {
    event,
    relays,
    publishAt,
    createdAt: now,
    status: "pending",
    attempts: 0,
  };

  await kv.set(["scheduled", event.pubkey, id], record, { expireIn: KV_TTL_MS });

  return jsonResponse(request, { id, publishAt }, 201);
}

async function handleListScheduled(pubkey: string, request: Request): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return errorResponse(request, "invalid pubkey");
  const out: Array<{
    id: string;
    publishAt: number;
    kind: number;
    content: string;
    relayCount: number;
    createdAt: number;
    status: string;
  }> = [];
  for await (const entry of kv.list<ScheduledRecord>({ prefix: ["scheduled", pubkey] })) {
    const id = entry.key[entry.key.length - 1] as string;
    const v = entry.value;
    out.push({
      id,
      publishAt: v.publishAt,
      kind: v.event.kind,
      content: v.event.content.slice(0, 100),
      relayCount: v.relays.length,
      createdAt: v.createdAt,
      status: v.status,
    });
  }
  return jsonResponse(request, out);
}

async function handleDelete(pubkey: string, id: string, request: Request): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return errorResponse(request, "invalid pubkey");

  // Require a signed challenge event in the body to prove ownership.
  // The challenge event must:
  //   - have pubkey matching the URL pubkey
  //   - have a valid signature
  //   - have created_at within 5 minutes of now (replay protection)
  //   - have a "challenge" tag containing the scheduled-post id being cancelled
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "missing signed challenge in body");
  }
  if (!body || typeof body !== "object" || !("challenge" in body)) {
    return errorResponse(request, "missing signed challenge in body");
  }
  const challenge = (body as { challenge: unknown }).challenge;
  if (!isValidEventShape(challenge)) return errorResponse(request, "invalid challenge event shape");
  if (challenge.pubkey !== pubkey) return errorResponse(request, "challenge pubkey mismatch");

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(challenge.created_at - now) > 300) {
    return errorResponse(request, "challenge expired or clock skew too large");
  }

  const challengeTag = challenge.tags.find((t) => t[0] === "challenge");
  if (!challengeTag || challengeTag[1] !== id) {
    return errorResponse(request, "challenge id does not match the post being cancelled");
  }

  if (!verifyEvent(challenge)) return errorResponse(request, "invalid challenge signature");

  const key = ["scheduled", pubkey, id];
  const existing = await kv.get<ScheduledRecord>(key);
  if (!existing.value) return errorResponse(request, "not found", 404);
  await kv.delete(key);
  return jsonResponse(request, { deleted: true });
}

// ---------- Cron: publish loop ----------

async function publishToRelay(relay: string, event: SignedNostrEvent): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(ok);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => finish(false), PUBLISH_TIMEOUT_MS);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(["EVENT", event]));
      } catch {
        clearTimeout(timer);
        finish(false);
      }
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === "string" ? msg.data : "");
        if (Array.isArray(data) && data[0] === "OK" && data[1] === event.id) {
          clearTimeout(timer);
          finish(Boolean(data[2]));
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); finish(false); };
    ws.onclose = () => { clearTimeout(timer); finish(false); };
  });
}

async function publishDueEvents(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let scanned = 0;
  let due = 0;
  for await (const entry of kv.list<ScheduledRecord>({ prefix: ["scheduled"] })) {
    scanned++;
    const v = entry.value;
    if (v.status !== "pending") continue;
    if (v.publishAt > now) continue;
    due++;

    console.log(`[publish-attempt] id=${v.event.id.slice(0, 8)} kind=${v.event.kind} publishAt=${v.publishAt} now=${now} relays=${v.relays.length}`);

    let anySuccess = false;
    const errors: string[] = [];
    for (const relay of v.relays) {
      const ok = await publishToRelay(relay, v.event);
      console.log(`[publish-relay] id=${v.event.id.slice(0, 8)} relay=${relay} ok=${ok}`);
      if (ok) anySuccess = true;
      else errors.push(relay);
    }

    if (anySuccess) {
      await kv.delete(entry.key);
      console.log(`[publish-ok] ${v.event.id.slice(0, 8)} kind=${v.event.kind} relays=${v.relays.length - errors.length}/${v.relays.length}`);
    } else {
      const attempts = v.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      const updated: ScheduledRecord = {
        ...v,
        attempts,
        status,
        lastError: `failed relays: ${errors.join(",")}`,
      };
      await kv.set(entry.key, updated, { expireIn: KV_TTL_MS });
      console.warn(`[publish-fail] ${v.event.id.slice(0, 8)} attempt=${attempts} status=${status} errors=${errors.join(",")}`);
    }
  }
  if (scanned > 0 || due > 0) {
    console.log(`[cron-tick] scanned=${scanned} due=${due}`);
  }
}

Deno.cron("publish-scheduled", "* * * * *", publishDueEvents);

// ---------- Server ----------

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (url.pathname === "/health") {
    return new Response("OK", { status: 200, headers: corsHeaders(request) });
  }

  if (request.method === "POST" && url.pathname === "/schedule") {
    return handleSchedule(request);
  }

  const listMatch = url.pathname.match(/^\/scheduled\/([0-9a-f]{64})$/);
  if (request.method === "GET" && listMatch) {
    return handleListScheduled(listMatch[1], request);
  }

  const delMatch = url.pathname.match(/^\/schedule\/([0-9a-f]{64})\/([^/]+)$/);
  if (request.method === "DELETE" && delMatch) {
    return handleDelete(delMatch[1], delMatch[2], request);
  }

  return errorResponse(request, "not found", 404);
});
