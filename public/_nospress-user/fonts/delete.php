<?php
/**
 * POST /fonts/delete.php
 *
 * Deletes one webfont file owned by the requester. Body is JSON: `{"url": "..."}`.
 * URL must live under https://<host>/fonts/<pubkey>/<filename>; only the
 * matching pubkey (as proven by the NIP-98 signature) can delete it.
 */
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
ob_start();

require_once __DIR__ . '/lib/Nip98.php';
require_once __DIR__ . '/lib/Bech32.php';

header('Content-Type: application/json');

function respond(int $status, array $body): void
{
    if (ob_get_level() > 0) ob_clean();
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['error' => 'Method not allowed']);
}

try {
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null);
    $rawBody = file_get_contents('php://input') ?: '';
    $event = Nip98::parseHeader($authHeader);

    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $path = strtok($_SERVER['REQUEST_URI'] ?? '', '?') ?: '';
    $absoluteUrl = $scheme . '://' . $host . $path;
    Nip98::verify($event, 'POST', $absoluteUrl, $rawBody);

    $pubkey = strtolower($event['pubkey']);
    if (!preg_match('/^[0-9a-f]{64}$/', $pubkey)) {
        respond(401, ['error' => 'Pubkey is not 64-char hex']);
    }
} catch (Nip98Exception $e) {
    respond(401, ['error' => 'auth: ' . $e->getMessage()]);
} catch (Throwable $e) {
    respond(500, ['error' => 'auth: internal — ' . $e->getMessage()]);
}

$body = json_decode($rawBody, true);
$targetUrl = is_array($body) ? ($body['url'] ?? '') : '';
if (!is_string($targetUrl) || $targetUrl === '') {
    respond(400, ['error' => 'Body must be {"url":"..."}']);
}

// Parse and validate the URL: must point at /_nospress-user/fonts/<our npub>/<filename>.
// The signing pubkey (hex) is re-encoded to npub and compared to the URL
// segment — no bech32 decode required server-side.
try {
    $authNpub = Bech32::encodeNpub($pubkey);
} catch (Throwable $e) {
    respond(500, ['error' => 'npub encode: ' . $e->getMessage()]);
}

$parts = parse_url($targetUrl);
if (!$parts || ($parts['host'] ?? '') !== $host) {
    respond(400, ['error' => 'URL host does not match this server']);
}
$p = $parts['path'] ?? '';
if (!preg_match('#^/_nospress-user/fonts/(npub1[a-z0-9]{58})/([a-z0-9-]{1,40}\.(?:woff2|woff|ttf|otf))$#', $p, $m)) {
    respond(400, ['error' => 'URL path is not a valid font location']);
}
if ($m[1] !== $authNpub) {
    respond(403, ['error' => "Cannot delete another user's file"]);
}

$filePath = __DIR__ . '/' . $authNpub . '/' . $m[2];
if (!file_exists($filePath)) {
    respond(404, ['error' => 'File not found']);
}
if (!@unlink($filePath)) {
    respond(500, ['error' => 'Delete failed']);
}

respond(200, ['ok' => true, 'deleted' => $targetUrl]);
