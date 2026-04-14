import { schnorr } from "npm:@noble/curves@1.6.0/secp256k1";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";
import { bytesToHex } from "npm:@noble/hashes@1.5.0/utils";

export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function getEventHash(event: SignedNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

export function verifyEvent(event: SignedNostrEvent): boolean {
  try {
    const computedId = getEventHash(event);
    if (computedId !== event.id) return false;
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    return false;
  }
}

export function isValidEventShape(e: unknown): e is SignedNostrEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.id === "string" && ev.id.length === 64 &&
    typeof ev.pubkey === "string" && ev.pubkey.length === 64 &&
    typeof ev.created_at === "number" &&
    typeof ev.kind === "number" &&
    Array.isArray(ev.tags) &&
    typeof ev.content === "string" &&
    typeof ev.sig === "string" && ev.sig.length === 128
  );
}
