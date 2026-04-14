/**
 * Noornote Scheduler — Hold & Forward service for scheduled Nostr posts.
 *
 * Client signs an event locally with `created_at = publishAt`, sends it here.
 * We hold it in Deno KV until publishAt, then publish via WebSocket to the
 * user's relays. No private key is ever on the server.
 */

import { isValidEventShape, type SignedNostrEvent, verifyEvent } from "./verify.ts";

const ALLOWED_ORIGIN = "https://noornote.app";
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

function corsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
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
    return errorResponse("invalid JSON body");
  }

  if (!body || typeof body !== "object") return errorResponse("body must be an object");
  const { event, relays, publishAt } = body as {
    event?: unknown;
    relays?: unknown;
    publishAt?: unknown;
  };

  if (!isValidEventShape(event)) return errorResponse("invalid event shape");
  if (!ALLOWED_KINDS.has(event.kind)) {
    return errorResponse(`kind ${event.kind} not allowed (only 1 and 30023)`);
  }

  if (!Array.isArray(relays) || relays.length === 0) {
    return errorResponse("relays must be a non-empty array");
  }
  if (relays.length > MAX_RELAYS) {
    return errorResponse(`max ${MAX_RELAYS} relays`);
  }
  for (const r of relays) {
    if (!isValidRelayUrl(r)) return errorResponse(`invalid relay URL: ${r}`);
  }

  if (typeof publishAt !== "number" || !Number.isFinite(publishAt)) {
    return errorResponse("publishAt must be a unix timestamp (number)");
  }
  const now = Math.floor(Date.now() / 1000);
  if (publishAt <= now + SCHEDULE_MIN_DELAY_S) {
    return errorResponse(`publishAt must be at least ${SCHEDULE_MIN_DELAY_S}s in the future`);
  }
  if (publishAt > now + SCHEDULE_MAX_DELAY_S) {
    return errorResponse(`publishAt cannot be more than 30 days in the future`);
  }
  if (publishAt !== event.created_at) {
    return errorResponse("publishAt must equal event.created_at");
  }

  if (!verifyEvent(event)) return errorResponse("invalid event signature");

  const pending = await countPending(event.pubkey);
  if (pending >= MAX_PENDING_PER_PUBKEY) {
    return errorResponse(`max ${MAX_PENDING_PER_PUBKEY} pending scheduled posts per pubkey`, 429);
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

  return jsonResponse({ id, publishAt }, 201);
}

async function handleListScheduled(pubkey: string): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return errorResponse("invalid pubkey");
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
  return jsonResponse(out);
}

async function handleDelete(pubkey: string, id: string): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return errorResponse("invalid pubkey");
  // V1: no auth on DELETE — there is no UI for it yet. V2 will require a
  // signed challenge before this endpoint is exposed in the UI.
  const key = ["scheduled", pubkey, id];
  const existing = await kv.get<ScheduledRecord>(key);
  if (!existing.value) return errorResponse("not found", 404);
  await kv.delete(key);
  return jsonResponse({ deleted: true });
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
  for await (const entry of kv.list<ScheduledRecord>({ prefix: ["scheduled"] })) {
    const v = entry.value;
    if (v.status !== "pending") continue;
    if (v.publishAt > now) continue;

    let anySuccess = false;
    const errors: string[] = [];
    for (const relay of v.relays) {
      const ok = await publishToRelay(relay, v.event);
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
      console.warn(`[publish-fail] ${v.event.id.slice(0, 8)} attempt=${attempts} status=${status}`);
    }
  }
}

Deno.cron("publish-scheduled", "* * * * *", publishDueEvents);

// ---------- Server ----------

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === "/health") {
    return new Response("OK", { status: 200, headers: corsHeaders() });
  }

  if (request.method === "POST" && url.pathname === "/schedule") {
    return handleSchedule(request);
  }

  const listMatch = url.pathname.match(/^\/scheduled\/([0-9a-f]{64})$/);
  if (request.method === "GET" && listMatch) {
    return handleListScheduled(listMatch[1]);
  }

  const delMatch = url.pathname.match(/^\/schedule\/([0-9a-f]{64})\/([^/]+)$/);
  if (request.method === "DELETE" && delMatch) {
    return handleDelete(delMatch[1], delMatch[2]);
  }

  return errorResponse("not found", 404);
});
