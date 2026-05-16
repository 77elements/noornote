<?php
/**
 * Pure-PHP bech32 encoder (BIP-0173) — just enough for hex pubkey → npub.
 * No external dependencies. Reference test vectors verified against the
 * reference Python implementation.
 *
 *   Bech32::encodeNpub('f527cf97…64-hex-chars') → 'npub1abc…'
 */
declare(strict_types=1);

final class Bech32
{
    private const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    private const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

    /** Encode a 32-byte hex pubkey as an `npub1…` bech32 string. */
    public static function encodeNpub(string $hexPubkey): string
    {
        if (!ctype_xdigit($hexPubkey) || strlen($hexPubkey) !== 64) {
            throw new InvalidArgumentException('encodeNpub: input must be 64-char hex');
        }
        $bytes = array_values(unpack('C*', hex2bin($hexPubkey)) ?: []);
        $data5 = self::convertBits($bytes, 8, 5, true);
        return self::encode('npub', $data5);
    }

    // --- internals -----------------------------------------------------------

    /** @param int[] $data 5-bit groups */
    private static function encode(string $hrp, array $data): string
    {
        $combined = array_merge($data, self::createChecksum($hrp, $data));
        $out = $hrp . '1';
        foreach ($combined as $v) {
            $out .= self::CHARSET[$v];
        }
        return $out;
    }

    /** @param int[] $values */
    private static function polymod(array $values): int
    {
        $chk = 1;
        foreach ($values as $v) {
            $b = $chk >> 25;
            $chk = (($chk & 0x1ffffff) << 5) ^ $v;
            for ($i = 0; $i < 5; $i++) {
                if (($b >> $i) & 1) $chk ^= self::GEN[$i];
            }
        }
        return $chk;
    }

    /** @return int[] */
    private static function hrpExpand(string $hrp): array
    {
        $out = [];
        $len = strlen($hrp);
        for ($i = 0; $i < $len; $i++) $out[] = ord($hrp[$i]) >> 5;
        $out[] = 0;
        for ($i = 0; $i < $len; $i++) $out[] = ord($hrp[$i]) & 31;
        return $out;
    }

    /** @param int[] $data 5-bit groups @return int[] 6 checksum values */
    private static function createChecksum(string $hrp, array $data): array
    {
        $values = array_merge(self::hrpExpand($hrp), $data, [0, 0, 0, 0, 0, 0]);
        $polymod = self::polymod($values) ^ 1;
        $out = [];
        for ($i = 0; $i < 6; $i++) {
            $out[] = ($polymod >> (5 * (5 - $i))) & 31;
        }
        return $out;
    }

    /** General base-N regrouping. @param int[] $data @return int[] */
    private static function convertBits(array $data, int $fromBits, int $toBits, bool $pad): array
    {
        $acc = 0;
        $bits = 0;
        $ret = [];
        $maxv = (1 << $toBits) - 1;
        $maxAcc = (1 << ($fromBits + $toBits - 1)) - 1;
        foreach ($data as $value) {
            if ($value < 0 || ($value >> $fromBits) !== 0) {
                throw new InvalidArgumentException('convertBits: value out of range');
            }
            $acc = (($acc << $fromBits) | $value) & $maxAcc;
            $bits += $fromBits;
            while ($bits >= $toBits) {
                $bits -= $toBits;
                $ret[] = ($acc >> $bits) & $maxv;
            }
        }
        if ($pad) {
            if ($bits) $ret[] = ($acc << ($toBits - $bits)) & $maxv;
        } elseif ($bits >= $fromBits || (($acc << ($toBits - $bits)) & $maxv)) {
            throw new InvalidArgumentException('convertBits: non-zero padding');
        }
        return $ret;
    }
}
