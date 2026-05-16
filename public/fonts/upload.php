<?php
/**
 * POST /fonts/upload.php
 *
 * Accepts a single webfont file via multipart/form-data, authenticated by a
 * NIP-98 (kind:27235) Authorization header. Stores under
 *   fonts/<pubkey-hex>/<sanitized-name>.<ext>
 * and returns the public URL.
 *
 * Quotas + format whitelist enforced in-process (no DB).
 */
declare(strict_types=1);

// Keep noise out of the response body: any stray notice/warning would
// otherwise be prepended to the JSON and break the client's JSON.parse.
ini_set('display_errors', '0');
error_reporting(E_ALL);
ob_start();

require_once __DIR__ . '/lib/Nip98.php';
require_once __DIR__ . '/lib/Bech32.php';

header('Content-Type: application/json');
// Same-origin only (defensive — the browser would already block cross-origin).
header('Vary: Origin');

// --- Constants ---------------------------------------------------------------

const MAX_FILE_BYTES   = 2 * 1024 * 1024;   // 2 MB per font
const MAX_FILES_PER_PUBKEY = 20;            // soft cap; bump when needed
const ALLOWED_EXT = ['woff2', 'woff', 'ttf', 'otf'];

/** Magic-byte sniff. Returns the canonical extension or null if unrecognized. */
function detectFontExt(string $bytes): ?string
{
    $h = substr($bytes, 0, 4);
    if ($h === 'wOF2') return 'woff2';
    if ($h === 'wOFF') return 'woff';
    if ($h === 'OTTO') return 'otf';
    if ($h === "\x00\x01\x00\x00" || $h === 'true') return 'ttf';
    return null;
}

/** Slug a user-supplied family name into a safe filename root. */
function slugify(string $s): string
{
    $s = strtolower(trim($s));
    $s = preg_replace('/[^a-z0-9-]+/', '-', $s) ?? '';
    $s = trim($s, '-');
    return $s === '' ? 'font' : substr($s, 0, 40);
}

function respond(int $status, array $body): void
{
    if (ob_get_level() > 0) ob_clean();
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

// --- Health check + self-test (GET) ------------------------------------------

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    if (isset($_GET['selftest'])) {
        try {
            $count = Bip340Verify::selfTest();
            respond(200, ['ok' => true, 'selftest' => 'passed', 'vectors' => $count]);
        } catch (Throwable $e) {
            respond(500, ['ok' => false, 'selftest' => 'failed', 'error' => $e->getMessage()]);
        }
    }
    respond(200, ['ok' => true, 'version' => '1']);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['error' => 'Method not allowed']);
}

// --- Auth --------------------------------------------------------------------

try {
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? null;
    // Some hosts strip Authorization; cPanel/Apache often exposes it via
    // REDIRECT_HTTP_AUTHORIZATION. Try fallback before failing.
    if (!$authHeader && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authHeader = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }

    // Client posts multipart/form-data with a 'file' part containing the
    // font bytes (raw application/octet-stream is blocked by many shared-
    // host WAFs). PHP parses it into $_FILES; we read the bytes from the
    // tmp file and use that as the NIP-98 payload-hash input.
    $upload = $_FILES['file'] ?? null;
    if (!is_array($upload) || ($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($upload['tmp_name'])) {
        respond(400, ['error' => "multipart field 'file' is missing or upload failed"]);
    }
    $rawBody = file_get_contents($upload['tmp_name']) ?: '';
    $event = Nip98::parseHeader($authHeader);

    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $path = strtok($_SERVER['REQUEST_URI'] ?? '', '?') ?: '';
    $query = $_SERVER['QUERY_STRING'] ?? '';
    $absoluteUrl = $scheme . '://' . $host . $path . ($query !== '' ? "?$query" : '');

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

// --- File ingest -------------------------------------------------------------

$family = trim($_GET['family'] ?? '');
if ($family === '') {
    respond(400, ['error' => "Query param 'family' is required"]);
}
if (strlen($family) > 60) {
    respond(400, ['error' => "Family name too long (max 60 chars)"]);
}

if ($rawBody === '' || strlen($rawBody) > MAX_FILE_BYTES) {
    respond(413, ['error' => 'File missing or exceeds ' . MAX_FILE_BYTES . ' bytes']);
}

$ext = detectFontExt($rawBody);
if ($ext === null) {
    respond(415, ['error' => 'File is not a recognized webfont (woff2/woff/ttf/otf)']);
}

// --- Storage -----------------------------------------------------------------

// Use the npub form for the on-disk directory and public URL — easier for
// the operator to scan via FTP ("which dir belongs to which user?"). The
// NIP-98 signature still binds to the hex pubkey; conversion is one-way
// and never re-decoded server-side.
try {
    $npub = Bech32::encodeNpub($pubkey);
} catch (Throwable $e) {
    respond(500, ['error' => 'npub encode: ' . $e->getMessage()]);
}

$root = __DIR__;
$userDir = $root . '/' . $npub;
if (!is_dir($userDir)) {
    if (!@mkdir($userDir, 0755, true) && !is_dir($userDir)) {
        respond(500, ['error' => 'Could not create user directory']);
    }
}

$existing = glob($userDir . '/*.{woff2,woff,ttf,otf}', GLOB_BRACE) ?: [];
$slug = slugify($family) . '.' . $ext;
$dest = $userDir . '/' . $slug;
$isReplace = file_exists($dest);

if (!$isReplace && count($existing) >= MAX_FILES_PER_PUBKEY) {
    respond(429, ['error' => 'Quota exceeded (' . MAX_FILES_PER_PUBKEY . ' fonts per pubkey)']);
}

if (file_put_contents($dest, $rawBody) === false) {
    respond(500, ['error' => 'Could not write file']);
}
@chmod($dest, 0644);

// --- Response ----------------------------------------------------------------

$publicUrl = $scheme . '://' . $host . '/fonts/' . $npub . '/' . $slug;
respond(200, [
    'ok'     => true,
    'url'    => $publicUrl,
    'format' => $ext === 'ttf' ? 'truetype' : ($ext === 'otf' ? 'opentype' : $ext),
    'size'   => strlen($rawBody),
]);
