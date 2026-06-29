/**
 * Check script: 100 programmatically-verifiable number-theory problems
 * (challenge-level scenario 4).
 *
 * 100 independent tasks are published to a shared tasklist; 8 mathematician
 * members self-claim and report each answer via an indexed marker
 * `<!-- ANSWER_<n>: <integer_value> -->`. Any member may claim any problem,
 * so we scan every <run_dir>/*.md file, build a Map<index, bigint> of
 * reported answers, and compare against 100 ground-truth answers that this
 * script computes independently via four classic number-theory routines:
 *
 *   - Family A (p1..p25):   prime-counting pi(N)        via Sieve of Eratosthenes
 *   - Family B (p26..p50):  sum-of-divisors sigma(n)    via trial division
 *   - Family C (p51..p75):  modular exponent 2^n mod p  via BigInt modPow
 *   - Family D (p76..p100): Euler totient phi(n)        via a totient sieve
 *
 * Pass iff >= 95 of the 100 reported answers match the ground truth
 * (tolerates a few flaky / missing claims).
 *
 * Usage:  bun check-math-100-problems.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs from all claimers
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// --------------------------------------------------------------------------
// Ground-truth helpers
// --------------------------------------------------------------------------

/**
 * Sieve of Eratosthenes up to N (inclusive).
 * Returns a boolean[] where isPrime[i] === true iff i is prime.
 */
function sievePrimes(N: number): boolean[] {
    const isPrime = new Array<boolean>(N + 1).fill(true);
    isPrime[0] = false;
    isPrime[1] = false;
    for (let i = 2; i * i <= N; i++) {
        if (isPrime[i]) {
            for (let j = i * i; j <= N; j += i) {
                isPrime[j] = false;
            }
        }
    }
    return isPrime;
}

/**
 * Prime-counting function pi(N): count of primes <= N.
 */
function primeCount(N: number): number {
    const isPrime = sievePrimes(N);
    let count = 0;
    for (let i = 2; i <= N; i++) {
        if (isPrime[i]) count++;
    }
    return count;
}

/**
 * Sum-of-divisors sigma(n): sum of all positive divisors of n
 * (including 1 and n itself). Uses O(sqrt(n)) trial division.
 */
function sumOfDivisors(n: number): number {
    let sum = 0;
    for (let d = 1; d * d <= n; d++) {
        if (n % d === 0) {
            sum += d;
            const complement = n / d;
            if (complement !== d) sum += complement;
        }
    }
    return sum;
}

/**
 * Modular exponentiation: (base^exp) mod mod, using BigInt so results stay
 * exact for the full 32-bit modulus range. Exponent must be non-negative.
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    if (mod <= 0n) throw new Error(`modulus must be positive, got ${mod}`);
    let result = 1n % mod;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
        if (e % 2n === 1n) result = (result * b) % mod;
        e = e / 2n;
        b = (b * b) % mod;
    }
    return result;
}

/**
 * Totient sieve: computes phi[0..N] in one linear-ish pass using the
 * classic formula phi[n] = n * prod (1 - 1/p) over distinct primes p | n.
 * For each prime p, subtract its contribution from every multiple.
 */
function totientSieve(N: number): number[] {
    const phi = new Array<number>(N + 1);
    for (let i = 0; i <= N; i++) phi[i] = i;
    for (let i = 2; i <= N; i++) {
        if (phi[i] === i) {
            // i is prime: apply (1 - 1/i) to all multiples of i.
            for (let j = i; j <= N; j += i) {
                phi[j] -= Math.floor(phi[j] / i);
            }
        }
    }
    return phi;
}

// --------------------------------------------------------------------------
// The 100 problems (4 families x 25)
// --------------------------------------------------------------------------

interface Problem {
    index: number; // 1..100
    ref: string; // "p1".."p100"
    family: string; // "pi" | "sigma" | "modpow" | "phi"
    answer: bigint; // ground truth
}

const MODPOW_MOD = 1000000007n; // 10^9 + 7

function buildProblems(): Problem[] {
    const problems: Problem[] = [];

    // Family A (p1..p25): pi(10*k) for k = 1..25, i.e. pi(10), pi(20), ..., pi(250).
    for (let k = 1; k <= 25; k++) {
        const n = 10 * k;
        problems.push({
            index: k,
            ref: `p${k}`,
            family: "pi",
            answer: BigInt(primeCount(n)),
        });
    }

    // Family B (p26..p50): sigma(n) for n = 101..125.
    for (let i = 26; i <= 50; i++) {
        const n = i + 75; // 101..125
        problems.push({
            index: i,
            ref: `p${i}`,
            family: "sigma",
            answer: BigInt(sumOfDivisors(n)),
        });
    }

    // Family C (p51..p75): 2^i mod (10^9+7) for i = 51..75
    // (base = 2, exponent = problem index, modulus = 1_000_000_007).
    for (let i = 51; i <= 75; i++) {
        problems.push({
            index: i,
            ref: `p${i}`,
            family: "modpow",
            answer: modPow(2n, BigInt(i), MODPOW_MOD),
        });
    }

    // Family D (p76..p100): phi(n) for n = 201..225.
    const phi = totientSieve(225);
    for (let i = 76; i <= 100; i++) {
        const n = i + 125; // 201..225
        problems.push({
            index: i,
            ref: `p${i}`,
            family: "phi",
            answer: BigInt(phi[n]),
        });
    }

    return problems;
}

// --------------------------------------------------------------------------
// Marker scan + assertion
// --------------------------------------------------------------------------

const ANSWER_N_RE = /<!--\s*ANSWER_(\d+):\s*(\d+)\s*-->/g;

const PASS_THRESHOLD = 95; // >= 95 of 100 must match

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error(
            "Usage: bun check-math-100-problems.ts <run_dir>",
        );
        process.exit(2);
    }

    let files: string[];
    try {
        files = (await readdir(runDir)).filter((f) => f.endsWith(".md"));
    } catch (err) {
        console.error(`IO error reading run dir: ${(err as Error).message}`);
        process.exit(2);
    }
    if (files.length === 0) {
        fail(`no .md member outputs found in ${runDir}`);
    }

    // Build Map<problem index, reported bigint> from every member output.
    // On duplicate index, keep the first occurrence (claims should agree
    // anyway; later duplicates are ignored).
    const reported = new Map<number, bigint>();
    let totalMarkers = 0;
    let malformed = 0;
    try {
        for (const f of files) {
            const raw = await readFile(join(runDir, f), "utf8");
            for (const m of raw.matchAll(ANSWER_N_RE)) {
                const idx = Number(m[1]);
                const valStr = m[2];
                if (!Number.isInteger(idx) || idx < 1 || idx > 100) {
                    malformed++;
                    continue;
                }
                if (reported.has(idx)) continue;
                reported.set(idx, BigInt(valStr));
                totalMarkers++;
            }
        }
    } catch (err) {
        console.error(`IO error reading member output: ${(err as Error).message}`);
        process.exit(2);
    }

    console.log(
        `  scanned ${files.length} file(s); collected ${totalMarkers} unique ANSWER_<n> markers (${malformed} out-of-range skipped)`,
    );

    const problems = buildProblems();

    // Per-family and overall accuracy.
    const familyStats: Record<string, { hit: number; total: number }> = {
        pi: { hit: 0, total: 0 },
        sigma: { hit: 0, total: 0 },
        modpow: { hit: 0, total: 0 },
        phi: { hit: 0, total: 0 },
    };

    const misses: string[] = [];
    let correct = 0;
    for (const p of problems) {
        familyStats[p.family].total++;
        const got = reported.get(p.index);
        if (got !== undefined && got === p.answer) {
            correct++;
            familyStats[p.family].hit++;
        } else {
            const gotStr = got === undefined ? "<missing>" : got.toString();
            misses.push(`${p.ref} (family ${p.family}): expected ${p.answer}, got ${gotStr}`);
        }
    }

    console.log("  per-family accuracy:");
    for (const fam of ["pi", "sigma", "modpow", "phi"] as const) {
        const s = familyStats[fam];
        console.log(`    ${fam.padEnd(8)} ${s.hit}/${s.total}`);
    }
    console.log(`  overall: ${correct}/${problems.length} (threshold >= ${PASS_THRESHOLD})`);

    if (correct < PASS_THRESHOLD) {
        const preview = misses.slice(0, 8).map((s) => `    - ${s}`).join("\n");
        const tail =
            misses.length > 8
                ? `\n    ... and ${misses.length - 8} more`
                : "";
        fail(
            `only ${correct}/${problems.length} answers correct; threshold is ${PASS_THRESHOLD}.\n` +
                `first misses:\n${preview}${tail}`,
        );
    }

    console.log(
        `PASS: ${correct}/${problems.length} answers correct (>= ${PASS_THRESHOLD}).`,
    );
}

main();
