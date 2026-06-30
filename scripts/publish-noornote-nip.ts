/**
 * Publish NoorNote's presence on Nostr. Two events, selected by flag:
 *
 *   (default)  kind 30817 — community-authored "NIP" / capability profile
 *              (Alex Gleason / NostrHub spec). Lists supported kinds via k-tags.
 *
 *   --app      kind 31990 — NIP-89 application handler. THIS is what lists NoorNote
 *              in app directories like nostrhub.io/apps (name, logo, website,
 *              platforms, handled kinds).
 *
 * Both are addressable/replaceable (one per pubkey + d-tag): re-running replaces
 * the previous version. Data lives in scripts/noornote-capabilities.json.
 *
 * Signing uses a NIP-46 remote signer (bunker); the key never leaves the bunker.
 * A local nsec via NOSTR_NSEC is supported as a fast path.
 *
 * Usage:
 *   bun scripts/publish-noornote-nip.ts --dry-run            # preview kind 30817
 *   bun scripts/publish-noornote-nip.ts --app --dry-run      # preview kind 31990 (app handler)
 *   NOSTR_BUNKER="bunker://..." bun scripts/publish-noornote-nip.ts --app   # publish app handler
 *   bun scripts/publish-noornote-nip.ts --app "bunker://..."                # same, bunker as arg
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { finalizeEvent, generateSecretKey, nip19, SimplePool } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";

// Persisted NIP-46 client key: authorize the bunker once, reuse it for later
// publishes so a fresh bunker URL isn't needed every time. Local-only, gitignored.
const CLIENT_KEY_FILE = join(homedir(), ".noornote-nip-client.key");

function loadOrCreateClientKey(): Uint8Array {
  if (existsSync(CLIENT_KEY_FILE)) {
    return hexToBytes(readFileSync(CLIENT_KEY_FILE, "utf8").trim());
  }
  const sk = generateSecretKey();
  writeFileSync(CLIENT_KEY_FILE, bytesToHex(sk), { mode: 0o600 });
  return sk;
}

// Broad, well-read relays incl. the Ditto/NostrHub ecosystem that indexes these kinds.
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

interface AppMeta {
  name: string;
  about: string;
  picture: string;
  website: string;
  handlers: Record<string, string>;
  topics: string[];
  nips: string[];
}

interface Capabilities {
  d: string;
  title: string;
  summary: string;
  homepage: string;
  app: AppMeta;
  kinds: [string, string][];
}

function loadCapabilities(): Capabilities {
  const raw = readFileSync(join(import.meta.dir, "noornote-capabilities.json"), "utf8");
  return JSON.parse(raw) as Capabilities;
}

/** kind 30817 — capability profile (Markdown body + k-tags). */
function build30817(cap: Capabilities) {
  const tags: string[][] = [
    ["d", cap.d],
    ["title", cap.title],
    ["summary", cap.summary],
    ["r", cap.homepage],
  ];
  for (const [num, name] of cap.kinds) tags.push(["k", num, name]);

  const body = [
    `# ${cap.title}`,
    "",
    cap.summary,
    "",
    `Homepage: ${cap.homepage}`,
    "",
    "## Supported event kinds",
    "",
    ...cap.kinds.map(([num, name]) => `- **kind:${num}** — ${name}`),
    "",
  ].join("\n");

  return { kind: 30817, created_at: Math.floor(Date.now() / 1000), tags, content: body };
}

/** kind 31990 — NIP-89 application handler (lists the app in directories). */
function build31990(cap: Capabilities) {
  const a = cap.app;
  const tags: string[][] = [
    ["d", cap.d],
    ["alt", `NIP-89 handler: ${a.name}`],
  ];
  // Platform handler URLs → drive the platform badges (Web/Android/Desktop/Linux/macOS).
  for (const [platform, url] of Object.entries(a.handlers)) tags.push([platform, url]);
  // Topic tags.
  for (const t of a.topics) tags.push(["t", t]);
  // Implemented NIPs → drive the directory's NIP-coverage rating.
  for (const n of a.nips) tags.push(["i", `https://github.com/nostr-protocol/nips/blob/master/${n}.md`]);
  // Handled event kinds.
  for (const [num] of cap.kinds) tags.push(["k", num]);

  const content = JSON.stringify({
    name: a.name,
    display_name: a.name,
    about: a.about,
    picture: a.picture,
    website: a.website,
  });

  return { kind: 31990, created_at: Math.floor(Date.now() / 1000), tags, content };
}

async function signAndPublish(signed: any, kind: number, identifier: string, pubkey: string) {
  console.log(`Broadcasting to ${RELAYS.length} relays...\n`);
  const pool = new SimplePool();
  const results = await Promise.allSettled(pool.publish(RELAYS, signed));
  results.forEach((res, i) =>
    console.log(`  ${res.status === "fulfilled" ? "OK  " : "FAIL"} ${RELAYS[i]}${res.status === "rejected" ? " — " + res.reason : ""}`),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  console.log(`\nDone. Accepted by ${ok}/${RELAYS.length} relays.`);
  console.log(`Event id: ${signed.id}`);
  console.log(`naddr: ${nip19.naddrEncode({ kind, pubkey, identifier, relays: [] })}`);
  pool.close(RELAYS);
}

async function main() {
  const flags = process.argv.slice(2);
  const isApp = flags.includes("--app");
  const isDry = flags.includes("--dry-run") || flags.includes("-n");
  const bunkerArg = flags.find((a) => !a.startsWith("-"));

  const cap = loadCapabilities();
  const template = isApp ? build31990(cap) : build30817(cap);
  const label = isApp ? "kind 31990 (NIP-89 app handler)" : "kind 30817 (capability profile)";

  if (isDry) {
    console.log(`DRY RUN — ${label}:\n`);
    console.log(JSON.stringify(template, null, 2));
    console.log(`\nk-tags: ${cap.kinds.length}. No signer used, nothing published.`);
    return;
  }

  console.log(`Publishing ${label}...`);

  // Fast path: local nsec via env var.
  const nsec = process.env.NOSTR_NSEC;
  if (nsec) {
    const sk = nip19.decode(nsec.trim()).data as Uint8Array;
    const signed = finalizeEvent(template, sk);
    console.log(`Signed as ${nip19.npubEncode(signed.pubkey)}`);
    await signAndPublish(signed, template.kind, cap.d, signed.pubkey);
    return;
  }

  const bunkerInput = bunkerArg || process.env.NOSTR_BUNKER;
  if (!bunkerInput) {
    console.error("No bunker connection string found.");
    console.error('Run: bun scripts/publish-noornote-nip.ts --app "bunker://..."');
    console.error('Or:  NOSTR_BUNKER="bunker://..." bun scripts/publish-noornote-nip.ts --app');
    console.error("Or preview: bun scripts/publish-noornote-nip.ts --app --dry-run");
    process.exit(1);
  }

  const bp = await parseBunkerInput(bunkerInput);
  if (!bp) {
    console.error("Could not parse the bunker connection string.");
    process.exit(1);
  }

  const clientSecretKey = loadOrCreateClientKey();
  const signer = BunkerSigner.fromBunker(clientSecretKey, bp, {
    onauth: (url) => console.log(`\nAuth required — approve in your signer:\n  ${url}\n`),
  });

  console.log("Connecting to remote signer (approve the request in your signer app)...");
  try {
    await signer.sendRequest("connect", [bp.pubkey, bp.secret || "", "sign_event"]);
  } catch (e) {
    if (!String(e).toLowerCase().includes("already connected")) throw e;
  }
  console.log("Signing...\n");

  const signed = await signer.signEvent(template);
  console.log(`Signed as ${nip19.npubEncode(signed.pubkey)}`);
  await signer.close();

  await signAndPublish(signed, template.kind, cap.d, signed.pubkey);
}

main().catch((err) => {
  console.error("Publish failed:", err);
  process.exit(1);
});
