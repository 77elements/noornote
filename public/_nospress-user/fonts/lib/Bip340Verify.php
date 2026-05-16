<?php
/**
 * BIP-340 Schnorr signature verification — self-contained, no Composer.
 * Reference: https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
 *
 * Uses only ext-gmp (standard PHP extension) + the built-in hash() function.
 *
 * Public API:
 *   Bip340Verify::verify(pubkeyHex32, sigHex64, msgHex32) : bool
 *
 * All inputs are lowercase-or-uppercase hex strings (decoded internally).
 * Returns true iff the signature is a valid BIP-340 signature on the
 * x-only pubkey + message.
 *
 * Self-test:
 *   Bip340Verify::selfTest()  // runs official BIP-340 test vectors,
 *                             // throws on mismatch.
 */
declare(strict_types=1);

final class Bip340Verify
{
    private static ?\GMP $p = null;   // field prime
    private static ?\GMP $n = null;   // curve order
    private static ?array $G = null;  // generator [x, y] as [GMP, GMP]

    private static function init(): void
    {
        if (self::$p !== null) return;
        self::$p = gmp_init('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F', 16);
        self::$n = gmp_init('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 16);
        self::$G = [
            gmp_init('79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798', 16),
            gmp_init('483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8', 16),
        ];
    }

    public static function verify(string $pubkeyHex, string $sigHex, string $msgHex): bool
    {
        self::init();

        if (!ctype_xdigit($pubkeyHex) || strlen($pubkeyHex) !== 64) return false;
        if (!ctype_xdigit($sigHex)    || strlen($sigHex)    !== 128) return false;
        if (!ctype_xdigit($msgHex)    || strlen($msgHex)    !== 64) return false;

        $px = gmp_init($pubkeyHex, 16);
        $r  = gmp_init(substr($sigHex, 0, 64), 16);
        $s  = gmp_init(substr($sigHex, 64, 64), 16);

        if (gmp_cmp($r, self::$p) >= 0) return false;
        if (gmp_cmp($s, self::$n) >= 0) return false;

        $P = self::liftX($px);
        if ($P === null) return false;

        // e = int(SHA256(tagHash || tagHash || bytes(r) || bytes(P) || m)) mod n
        $tagHash = hash('sha256', 'BIP0340/challenge', true);
        $eHash = hash(
            'sha256',
            $tagHash . $tagHash . self::intToBytes32($r) . hex2bin($pubkeyHex) . hex2bin($msgHex),
            true
        );
        $e = gmp_mod(gmp_init(bin2hex($eHash), 16), self::$n);

        // R = s·G - e·P  ==  s·G + (n - e)·P  (avoids point negation logic)
        $sG = self::scalarMul(self::$G, $s);
        $eP = self::scalarMul($P, gmp_sub(self::$n, $e));
        $R = self::pointAdd($sG, $eP);

        if ($R === null) return false;
        if (gmp_testbit($R[1], 0)) return false;  // R.y must be even
        return gmp_cmp($R[0], $r) === 0;
    }

    /** Lift x-only coord to a full curve point (x, y) with even y. */
    private static function liftX(\GMP $x): ?array
    {
        if (gmp_cmp($x, self::$p) >= 0) return null;
        $two   = gmp_init(2);
        $three = gmp_init(3);
        $seven = gmp_init(7);
        // y² = x³ + 7  (mod p)
        $ySq = gmp_mod(gmp_add(gmp_powm($x, $three, self::$p), $seven), self::$p);
        // p ≡ 3 (mod 4) ⇒ sqrt(y²) = y²^((p+1)/4) (mod p)
        $exp = gmp_div_q(gmp_add(self::$p, gmp_init(1)), gmp_init(4));
        $y = gmp_powm($ySq, $exp, self::$p);
        // Verify it really is a square root (otherwise x is not on the curve)
        if (gmp_cmp(gmp_powm($y, $two, self::$p), $ySq) !== 0) return null;
        // Force even y (BIP-340 x-only convention)
        if (gmp_testbit($y, 0)) {
            $y = gmp_sub(self::$p, $y);
        }
        return [$x, $y];
    }

    /** Affine point addition; null encodes the point at infinity. */
    private static function pointAdd(?array $P1, ?array $P2): ?array
    {
        if ($P1 === null) return $P2;
        if ($P2 === null) return $P1;

        $sameX = gmp_cmp($P1[0], $P2[0]) === 0;
        $sameY = gmp_cmp($P1[1], $P2[1]) === 0;
        if ($sameX && !$sameY) return null;     // P + (−P) = ∞

        if ($sameX && $sameY) {
            // Doubling: λ = (3·x²) / (2·y)
            $num = gmp_mod(gmp_mul(gmp_init(3), gmp_powm($P1[0], gmp_init(2), self::$p)), self::$p);
            $den = gmp_mod(gmp_mul(gmp_init(2), $P1[1]), self::$p);
        } else {
            // Addition: λ = (y2 − y1) / (x2 − x1)
            $num = gmp_mod(gmp_sub($P2[1], $P1[1]), self::$p);
            $den = gmp_mod(gmp_sub($P2[0], $P1[0]), self::$p);
        }
        // Modular inverse via Fermat's little theorem: a^(p−2) mod p
        $denInv = gmp_powm($den, gmp_sub(self::$p, gmp_init(2)), self::$p);
        $lam = gmp_mod(gmp_mul($num, $denInv), self::$p);
        $x3 = gmp_mod(gmp_sub(gmp_sub(gmp_mul($lam, $lam), $P1[0]), $P2[0]), self::$p);
        $y3 = gmp_mod(gmp_sub(gmp_mul($lam, gmp_sub($P1[0], $x3)), $P1[1]), self::$p);
        // gmp_mod may return a negative residue if the dividend was negative; normalize.
        if (gmp_sign($x3) < 0) $x3 = gmp_add($x3, self::$p);
        if (gmp_sign($y3) < 0) $y3 = gmp_add($y3, self::$p);
        return [$x3, $y3];
    }

    /** Constant-time-ish double-and-add scalar mult; n is a 256-bit GMP. */
    private static function scalarMul(array $P, \GMP $n): ?array
    {
        $R = null;
        for ($i = 0; $i < 256; $i++) {
            if (gmp_testbit($n, $i)) {
                $R = self::pointAdd($R, $P);
            }
            $P = self::pointAdd($P, $P);
        }
        return $R;
    }

    /** GMP → 32-byte big-endian binary string. */
    private static function intToBytes32(\GMP $n): string
    {
        $hex = gmp_strval($n, 16);
        if (strlen($hex) > 64) throw new RuntimeException('int too large for 32 bytes');
        return hex2bin(str_pad($hex, 64, '0', STR_PAD_LEFT));
    }

    /**
     * Run the official BIP-340 test vectors (a small subset — enough to catch
     * any mid-arithmetic bug). Throws RuntimeException on mismatch, returns the
     * pass count on success. Use via `?selftest=1` on the upload endpoint.
     */
    public static function selfTest(): int
    {
        // (pubkey, msg, sig, expected) — from BIP-340 test-vectors.csv
        $vectors = [
            // Index 0 — valid
            [
                'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
                '0000000000000000000000000000000000000000000000000000000000000000',
                'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0',
                true,
            ],
            // Index 1 — valid (different msg)
            [
                'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
                '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
                '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A',
                true,
            ],
            // Index 5 — public key not on curve
            [
                'EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34',
                '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
                '6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769961764B3AA9B2FFCB6EF947B6887A226E8D7C93E00C5ED0C1834FF0D0C2E6DA6',
                false,
            ],
            // Index 14 — invalid s (s == n)
            [
                'D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9',
                '4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703',
                '00000000000000000000000000000000FD17B448A68554199C47D08FFB10D4B8FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
                false,
            ],
        ];
        $passed = 0;
        foreach ($vectors as $i => [$pk, $msg, $sig, $expected]) {
            $got = self::verify($pk, $sig, $msg);
            if ($got !== $expected) {
                throw new RuntimeException("BIP-340 self-test vector #$i: expected " . var_export($expected, true) . ", got " . var_export($got, true));
            }
            $passed++;
        }
        return $passed;
    }
}
