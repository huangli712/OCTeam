/**
 * Check script: math problem router (calculus classification).
 *
 * Verifies the router member classified the derivative problem as "calculus"
 * and the matched branch member (bob) produced the correct product-rule
 * derivative: d/dx[x^3 * sin(x)] = 3x^2*sin(x) + x^3*cos(x).
 *
 * Usage:  bun check-math-problem-router.ts <run_dir>
 *   <run_dir>  directory containing alice.md and bob.md
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertion)  |  2 usage / IO error
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROUTER = "alice";
const BRANCH_TO_MEMBER: Record<string, string> = {
    calculus: "bob",
    algebra: "carol",
    "number-theory": "dave",
    combinatorics: "erin",
};
const EXPECTED_BRANCH = "calculus";

const ROUTE_TAG_RE = /<route>([\s\S]*?)<\/route>/;
const ANSWER_RE = /<!--\s*ANSWER:\s*([\s\S]*?)\s*-->/;
const DOMAIN_FALSE_RE = /<!--\s*DOMAIN_MATCH:\s*false\s*-->/

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

/**
 * Extract the routed branch name from the router's <route>{...} decision.
 * Accepts both single-branch {"branch": "x"} and multi-branch
 * {"branches": ["x", ...]} forms (takes the first in the latter case).
 */
function extractBranch(routerRaw: string): { branch: string | null; raw: string } {
    const tag = routerRaw.match(ROUTE_TAG_RE);
    if (!tag) return { branch: null, raw: "" };
    let parsed: { branch?: string; branches?: string[] };
    try {
        parsed = JSON.parse(tag[1]);
    } catch {
        return { branch: null, raw: tag[1] };
    }
    const branch =
        parsed.branch ?? (Array.isArray(parsed.branches) ? parsed.branches[0] : undefined);
    return { branch: branch ?? null, raw: tag[1] };
}

/**
 * Normalize a math expression for tolerant comparison:
 * drop whitespace, fold `**` to `^`, strip multiplication asterisks, lowercase.
 * Tolerates 3*x^2*sin(x), 3x^2*sin(x), x**3*cos(x), etc.
 */
function normalizeExpr(s: string): string {
    return s
        .replace(/\s+/g, "")
        .replace(/\*\*/g, "^")
        .replace(/\*/g, "")
        .toLowerCase();
}

/**
 * Convert a normalized math expression (digits, x, ^, known functions, with
 * implicit multiplication by juxtaposition) into an evaluatable JavaScript
 * expression body. Used for numerical equivalence checking when the literal
 * expanded-term matcher fails — e.g. the member submitted a factored form
 * like `x^2(3sin(x)+xcos(x))` which is mathematically identical to the
 * expanded `3x^2sin(x)+x^3cos(x)` but contains neither term as a literal.
 *
 * Returns null if the expression contains characters outside the safe set.
 */
function toEvaluable(expr: string): string | null {
    // Only allow a safe character set; reject anything unexpected.
    if (!/^[\dx+\-*/^(). a-z]+$/.test(expr)) return null;
    let s = expr;
    // 1. implicit multiplication by juxtaposition FIRST, so that e.g. `3sin`
    //    becomes `3*sin` and the subsequent function-name regex (`\bsin\b`)
    //    can match — otherwise `3sin` has no left word boundary before `sin`.
    //    a) digit before a letter or '('  (3x, 3sin, 2()
    s = s.replace(/(\d)(?=[a-z(])/g, "$1*");
    //    b) ')' before a letter, digit, or '('
    s = s.replace(/(\))(?=[a-z0-9(])/g, "$1*");
    //    c) standalone variable x before a letter or '(' — but NOT an `x`
    //       that is part of an identifier (preceded by a letter/digit/dot).
    //       Bun supports the negative lookbehind.
    s = s.replace(/(?<![a-z0-9.])x(?=[a-z(])/g, "x*");
    // 2. power operator
    s = s.replace(/\^/g, "**");
    // 3. known functions -> Math.* (ln has no Math alias; map to Math.log).
    //    `log2`/`log10` are deliberately omitted — their embedded digits would
    //    be split by the implicit-multiplication step above.
    s = s.replace(
        /\b(sin|cos|tan|sec|csc|cot|asin|acos|atan|sinh|cosh|tanh|ln|log|exp|sqrt|abs|cbrt)\b/g,
        "Math.$1",
    );
    s = s.replace(/\bMath\.ln\b/g, "Math.log");
    return s;
}

/**
 * Numerically test whether the member's answer is equivalent to the true
 * product-rule derivative f'(x) = 3x^2 sin(x) + x^3 cos(x), by sampling at
 * several points and comparing. Tolerant of floating-point noise. Returns
 * false if the expression cannot be parsed/evaluated.
 */
function numericallyEqualToDerivative(normalized: string): boolean {
    const body = toEvaluable(normalized);
    if (body === null) return false;
    let fn: (x: number) => number;
    try {
        // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
        fn = new Function("x", `return (${body});`) as (x: number) => number;
    } catch {
        return false;
    }
    const trueDeriv = (x: number): number =>
        3 * x * x * Math.sin(x) + x * x * x * Math.cos(x);
    const samplePoints = [-5.3, -2.9, -1.4, -0.6, 0.3, 1.7, 2.8, 4.5, 6.1];
    for (const x of samplePoints) {
        let memberVal: number;
        try {
            memberVal = fn(x);
        } catch {
            return false;
        }
        if (!Number.isFinite(memberVal)) return false;
        if (Math.abs(memberVal - trueDeriv(x)) > 1e-9) return false;
    }
    return true;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-math-problem-router.ts <run_dir>");
        process.exit(2);
    }

    // Load router output.
    let routerRaw: string;
    try {
        routerRaw = await readFile(join(runDir, `${ROUTER}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${ROUTER}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    const { branch, raw } = extractBranch(routerRaw);
    if (branch === null) {
        fail(
            `router "${ROUTER}" did not emit a parseable ` +
                `<route>{"branch": ...}</route> decision (raw: ${raw || "<no route tag>"})`,
        );
    }
    console.log(`  router picked branch: ${branch}`);

    // Assertion 1: router selected the expected branch.
    if (branch !== EXPECTED_BRANCH) {
        fail(`router selected "${branch}", expected "${EXPECTED_BRANCH}"`);
    }

    // Load the matched branch member's output.
    const member = BRANCH_TO_MEMBER[EXPECTED_BRANCH];
    let expertRaw: string;
    try {
        expertRaw = await readFile(join(runDir, `${member}.md`), "utf8");
    } catch (err) {
        console.error(`IO error reading ${member}.md: ${(err as Error).message}`);
        process.exit(2);
    }

    // Assertion 2: matched branch did not reject the problem.
    if (DOMAIN_FALSE_RE.test(expertRaw)) {
        fail(
            `matched branch "${member}" rejected the problem (DOMAIN_MATCH: false) ` +
                `— routing was correct but the expert disowned it`,
        );
    }

    // Assertion 3: matched branch produced an ANSWER marker.
    const ansMatch = expertRaw.match(ANSWER_RE);
    if (!ansMatch) {
        fail(`matched branch "${member}" did not emit <!-- ANSWER: ... -->`);
    }
    const answer = ansMatch[1];
    console.log(`  ${member} ANSWER: ${answer.trim()}`);

    // Assertion 4: answer matches the product-rule derivative
    //   d/dx[x^3 sin(x)] = 3x^2 sin(x) + x^3 cos(x).
    // Primary (fast path): literal expanded terms — order independent,
    // tolerant of `*` / `**` / whitespace.
    // Fallback: numerical equivalence at sample points — accepts factored or
    // other mathematically equivalent closed forms (e.g. x^2(3sin(x)+xcos(x))).
    const norm = normalizeExpr(answer);
    const hasFirstTerm = /3x\^2sin\(x\)/.test(norm);
    const hasSecondTerm = /x\^3cos\(x\)/.test(norm);
    const literalMatch = hasFirstTerm && hasSecondTerm;
    const numericalMatch = literalMatch ? true : numericallyEqualToDerivative(norm);
    if (!literalMatch && numericalMatch) {
        console.log("  (literal expanded-term match failed; numerical equivalence PASSED)");
    }
    if (!numericalMatch) {
        fail(
            `answer does not match product-rule derivative 3x^2*sin(x) + x^3*cos(x) ` +
                `(normalized: ${norm})`,
        );
    }

    console.log("PASS: router selected calculus; bob derived 3x^2*sin(x) + x^3*cos(x).");
}

main();
