/**
 * Publish (or update) NoorNote's public capability profile as a kind 30817 event
 * ("community-authored NIP" / NUD, as defined by the Alex Gleason / NostrHub spec).
 *
 * kind 30817 is an addressable/replaceable event: there is exactly ONE such event
 * per (pubkey, d-tag). Re-running this script with the same signer REPLACES the
 * previous version, so directories always read the latest capability list.
 *
 * The capability data (title, summary, list of supported kinds) lives in
 * scripts/noornote-capabilities.json — that file is the single source to edit
 * whenever NoorNote starts supporting a new kind (see /kinds skill, point 13).
 *
 * Signing uses a NIP-46 REMOTE SIGNER (bunker). The private key never leaves the
 * bunker; this script only sends an unsigned event and receives it back signed.
 *
 * Usage:
 *   bun scripts/publish-noornote-nip.ts --dry-run          # build + print event, no signer, no publish
 *   bun scripts/publish-noornote-nip.ts "bunker://..."     # connect, sign, broadcast
 *   NOSTR_BUNKER="bunker://..." bun scripts/publish-noornote-nip.ts   # same, via env var
 *
 * The bunker connection string can be passed as the argument or via the
 * NOSTR_BUNKER env var. The env var keeps it out of shell history / process args;
 * the argument is more convenient but is visible in `ps`/history. Either way the
 * private key never leaves the bunker — this script only gets a signed event back.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, nip19, SimplePool } from "nostr-tools";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";

// Broad, well-read relays incl. the Ditto/NostrHub ecosystem that indexes kind 30817.
const RELAYS = [
  "wss://relay.ditto.pub",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://purplepag.es",
  "wss://relay.snort.social",
  "wss://nostr.wine",
];

interface Capabilities {
  d: string;
  title: string;
  summary: string;
  homepage: string;
  kinds: [string, string][];
}

function loadCapabilities(): Capabilities {
  const raw = readFileSync(join(import.meta.dir, "noornote-capabilities.json"), "utf8");
  return JSON.parse(raw) as Capabilities;
}

/** Build the human-readable Markdown body from the capability list. */
function buildContent(cap: Capabilities): string {
  const lines: string[] = [];
  lines.push(`# ${cap.title}`);
  lines.push("");
  lines.push(cap.summary);
  lines.push("");
  lines.push(`Homepage: ${cap.homepage}`);
  lines.push("");
  lines.push("## Supported event kinds");
  lines.push("");
  for (const [num, name] of cap.kinds) {
    lines.push(`- **kind:${num}** — ${name}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildEventTemplate(cap: Capabilities) {
  const tags: string[][] = [
    ["d", cap.d],
    ["title", cap.title],
    ["summary", cap.summary],
    ["r", cap.homepage],
  ];
  for (const [num, name] of cap.kinds) {
    tags.push(["k", num, name]);
  }
  return {
    kind: 30817,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: buildContent(cap),
  };
}

async function main() {
  const arg = process.argv[2];
  const cap = loadCapabilities();
  const template = buildEventTemplate(cap);

  if (arg === "--dry-run" || arg === "-n") {
    console.log("DRY RUN — event that WOULD be published (kind 30817):\n");
    console.log(JSON.stringify(template, null, 2));
    console.log(`\nk-tags: ${cap.kinds.length} kinds declared.`);
    console.log("No signer used, nothing published.");
    return;
  }

  // Fast path: local nsec via env var (no bunker handshake).
  const nsec = process.env.NOSTR_NSEC;
  if (nsec) {
    const sk = nip19.decode(nsec.trim()).data as Uint8Array;
    const signed = finalizeEvent(template, sk);
    console.log(`Signed as ${nip19.npubEncode(signed.pubkey)}, broadcasting to ${RELAYS.length} relays...\n`);
    const pool = new SimplePool();
    const results = await Promise.allSettled(pool.publish(RELAYS, signed));
    results.forEach((res, i) =>
      console.log(`  ${res.status === "fulfilled" ? "OK  " : "FAIL"} ${RELAYS[i]}${res.status === "rejected" ? " — " + res.reason : ""}`),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.log(`\nDone. Accepted by ${ok}/${RELAYS.length} relays.`);
    console.log(`naddr: ${nip19.naddrEncode({ kind: 30817, pubkey: signed.pubkey, identifier: cap.d, relays: [] })}`);
    pool.close(RELAYS);
    return;
  }

  const bunkerInput = arg || process.env.NOSTR_BUNKER;
  if (!bunkerInput) {
    console.error("No bunker connection string found.");
    console.error('Run: bun scripts/publish-noornote-nip.ts "bunker://..."');
    console.error('Or:  NOSTR_BUNKER="bunker://..." bun scripts/publish-noornote-nip.ts');
    console.error("Or preview without signing: bun scripts/publish-noornote-nip.ts --dry-run");
    process.exit(1);
  }

  const bp = await parseBunkerInput(bunkerInput);
  if (!bp) {
    console.error("Could not parse NOSTR_BUNKER as a bunker:// URL or NIP-05 bunker identifier.");
    process.exit(1);
  }

  // Ephemeral local key for the client side of the NIP-46 channel (not the signing key).
  const clientSecretKey = generateSecretKey();
  const signer = BunkerSigner.fromBunker(clientSecretKey, bp, {
    onauth: (url) => {
      console.log(`\nAuth required — approve in your signer:\n  ${url}\n`);
    },
  });

  console.log("Connecting to remote signer (approve the request in your signer app)...");
  try {
    // Request sign_event permission up front so the signer prompts for approval.
    await signer.sendRequest("connect", [bp.pubkey, bp.secret || "", "sign_event"]);
  } catch (e) {
    // Some bunkers reply "already connected" when the session is already live.
    if (!String(e).toLowerCase().includes("already connected")) throw e;
  }
  console.log(`Declaring ${cap.kinds.length} supported kinds, signing...\n`);

  const signed = await signer.signEvent(template);
  const npub = nip19.npubEncode(signed.pubkey);
  console.log(`Signed as ${npub}`);
  await signer.close();

  console.log(`Broadcasting to ${RELAYS.length} relays...\n`);
  const pool = new SimplePool();
  const results = await Promise.allSettled(pool.publish(RELAYS, signed));

  results.forEach((res, i) => {
    const relay = RELAYS[i];
    if (res.status === "fulfilled") {
      console.log(`  OK    ${relay}`);
    } else {
      console.log(`  FAIL  ${relay} — ${res.reason}`);
    }
  });

  const ok = results.filter((r) => r.status === "fulfilled").length;
  console.log(`\nDone. Accepted by ${ok}/${RELAYS.length} relays.`);
  console.log(`Event id: ${signed.id}`);
  console.log(`Address:  ${nip19.naddrEncode({ kind: 30817, pubkey: signed.pubkey, identifier: cap.d, relays: [] })}`);

  pool.close(RELAYS);
}

main().catch((err) => {
  console.error("Publish failed:", err);
  process.exit(1);
});
