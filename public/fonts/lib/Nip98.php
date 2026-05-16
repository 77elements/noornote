<?php
/**
 * NIP-98 HTTP Auth verification — kind:27235 Authorization-header check.
 * See: https://github.com/nostr-protocol/nips/blob/master/98.md
 *
 * Caller chain:
 *   $auth = Nip98::parseHeader($_SERVER['HTTP_AUTHORIZATION']);
 *   Nip98::verify($auth, 'POST', $absoluteUrl, $bodyBytes); // throws on failure
 *   $pubkey = $auth['pubkey']; // 64-char hex
 *
 * Throws Nip98Exception on every failure (caught and 401'd by the endpoint).
 */
declare(strict_types=1);

require_once __DIR__ . '/Bip340Verify.php';

class Nip98Exception extends RuntimeException {}

final class Nip98
{
    /** Max clock-skew in seconds. NIP-98 suggests 60s. */
    public const FRESHNESS_WINDOW = 60;

    /**
     * Parse the `Authorization: Nostr <base64>` header into the inner event.
     * Returns the event as an assoc array.
     */
    public static function parseHeader(?string $header): array
    {
        if (!$header || !str_starts_with($header, 'Nostr ')) {
            throw new Nip98Exception('Missing or malformed Authorization header');
        }
        $b64 = substr($header, 6);
        $json = base64_decode($b64, true);
        if ($json === false) {
            throw new Nip98Exception('Authorization payload is not valid base64');
        }
        $event = json_decode($json, true);
        if (!is_array($event)) {
            throw new Nip98Exception('Authorization payload is not valid JSON');
        }
        foreach (['id', 'pubkey', 'sig', 'kind', 'created_at', 'tags', 'content'] as $f) {
            if (!array_key_exists($f, $event)) {
                throw new Nip98Exception("Auth event missing field: $f");
            }
        }
        return $event;
    }

    /**
     * Verify every NIP-98 invariant. Throws on first violation.
     * @param array  $event       Decoded auth event (from parseHeader)
     * @param string $method      Expected HTTP method (uppercase)
     * @param string $absoluteUrl Expected absolute request URL incl. query string
     * @param string $bodyBytes   Raw request body (used to compute payload SHA-256)
     */
    public static function verify(array $event, string $method, string $absoluteUrl, string $bodyBytes): void
    {
        if ((int)$event['kind'] !== 27235) {
            throw new Nip98Exception('Auth event kind must be 27235');
        }
        $age = abs(time() - (int)$event['created_at']);
        if ($age > self::FRESHNESS_WINDOW) {
            throw new Nip98Exception("Auth event too old/skewed ($age s, max " . self::FRESHNESS_WINDOW . ')');
        }

        $tags = $event['tags'];
        $u = self::tagValue($tags, 'u');
        $m = self::tagValue($tags, 'method');
        $p = self::tagValue($tags, 'payload');

        if ($u !== $absoluteUrl) {
            throw new Nip98Exception("Auth event 'u' tag does not match request URL");
        }
        if (strtoupper($m ?? '') !== strtoupper($method)) {
            throw new Nip98Exception("Auth event 'method' tag does not match request method");
        }
        if ($bodyBytes !== '' && strtolower($p ?? '') !== hash('sha256', $bodyBytes)) {
            throw new Nip98Exception("Auth event 'payload' tag does not match body SHA-256");
        }

        // Recompute the event id and verify it matches the claimed id.
        // Per NIP-01: id = sha256(json([0, pubkey, created_at, kind, tags, content])).
        $serialized = json_encode(
            [0, $event['pubkey'], (int)$event['created_at'], (int)$event['kind'], $tags, $event['content']],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        );
        $computedId = hash('sha256', $serialized);
        if (!hash_equals($computedId, $event['id'])) {
            throw new Nip98Exception('Auth event id does not match serialized payload (tampered or wrong serialization)');
        }

        // BIP-340 Schnorr signature verification (self-contained, no deps).
        if (!Bip340Verify::verify($event['pubkey'], $event['sig'], $event['id'])) {
            throw new Nip98Exception('Auth event Schnorr signature invalid');
        }
    }

    private static function tagValue(array $tags, string $name): ?string
    {
        foreach ($tags as $t) {
            if (is_array($t) && count($t) >= 2 && $t[0] === $name) {
                return (string)$t[1];
            }
        }
        return null;
    }
}
