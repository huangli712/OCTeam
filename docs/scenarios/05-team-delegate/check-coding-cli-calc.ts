/**
 * Check script: CLI calculator with blockedBy DAG (4 dependent tasks).
 *
 * Delegate mode: any of the 3 coder members may claim any task, so we scan
 * every <run_dir>/*.md for the four markers (SPEC_OK, IMPL: calculate,
 * IMPL: format, PASS_COUNT). We additionally locate the member output that
 * claimed the `calculate` task, extract its TypeScript code block, and run
 * the 4 canonical test cases against the loaded function.
 *
 * Usage:  bun check-coding-cli-calc.ts <run_dir>
 *   <run_dir>  directory containing <member>.md outputs from all claimers
 *
 * Exit codes:  0 PASS  |  1 FAIL (assertions)  |  2 usage / IO error
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

interface CalcCase {
    op: string;
    a: number;
    b: number;
    expected: number;
}

// The 4 canonical test cases the tests task (task D) must pass.
const CASES: CalcCase[] = [
    { op: "add", a: 2, b: 3, expected: 5 },
    { op: "sub", a: 10, b: 4, expected: 6 },
    { op: "mul", a: 3, b: 7, expected: 21 },
    { op: "div", a: 20, b: 4, expected: 5 },
];

const SPEC_OK_RE = /<!--\s*SPEC_OK:\s*(\w+)\s*-->/;
const IMPL_CALC_RE = /<!--\s*IMPL:\s*calculate\s*-->/;
const IMPL_FORMAT_RE = /<!--\s*IMPL:\s*format\s*-->/;
const PASS_COUNT_RE = /<!--\s*PASS_COUNT:\s*(\d+)\s*\/\s*4\s*-->/;
const CODE_RE = /```typescript\s*\n([\s\S]*?)```/;

function fail(msg: string): never {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
}

async function readAllFiles(runDir: string): Promise<Map<string, string>> {
    const files = (await readdir(runDir)).filter((f) => f.endsWith(".md"));
    const map = new Map<string, string>();
    for (const f of files) {
        map.set(f, await readFile(join(runDir, f), "utf8"));
    }
    return map;
}

function loadCalculate(
    code: string,
): (op: string, a: number, b: number) => number {
    // Wrap the member code and return the declared `calculate`. The member
    // prompt fixes the signature `function calculate(op, a, b)`, so this
    // works for both function declarations and `const calculate = ...` forms.
    // Members write real TypeScript (type aliases, annotations, `export`).
    // `new Function` evaluates a function body, not a module, so (1) type
    // aliases/annotations must be transpiled away and (2) the module-level
    // `export` keyword must be stripped. Bun.Transpiler handles (1); a regex
    // handles (2).
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    const codeLoadable = transpiled.replace(/\bexport\s+/g, "");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
        `${codeLoadable}; return typeof calculate === "function" ? calculate : null;`,
    ) as () => ((op: string, a: number, b: number) => number) | null;
    const fn = factory();
    if (typeof fn !== "function") {
        throw new Error("code did not expose a `calculate` function");
    }
    return fn;
}

async function main(): Promise<void> {
    const runDir = process.argv[2];
    if (!runDir) {
        console.error("Usage: bun check-coding-cli-calc.ts <run_dir>");
        process.exit(2);
    }

    let outputs: Map<string, string>;
    try {
        outputs = await readAllFiles(runDir);
    } catch (err) {
        console.error(`IO error: ${(err as Error).message}`);
        process.exit(2);
    }
    if (outputs.size === 0) {
        fail(`no .md member outputs found in ${runDir}`);
    }

    // Concatenate all outputs for marker scanning.
    const blob = [...outputs.values()].join("\n");

    // Assertion 1: <!-- SPEC_OK: true -->
    const specMatch = blob.match(SPEC_OK_RE);
    if (!specMatch) {
        fail("<!-- SPEC_OK: ... --> marker not found");
    }
    if (specMatch[1].toLowerCase() !== "true") {
        fail(`SPEC_OK = "${specMatch[1]}" expected "true"`);
    }
    console.log("  spec marker: SPEC_OK = true");

    // Assertion 2: <!-- IMPL: calculate -->
    if (!IMPL_CALC_RE.test(blob)) {
        fail("<!-- IMPL: calculate --> marker not found");
    }
    console.log("  impl marker: IMPL: calculate present");

    // Assertion 3: <!-- IMPL: format -->
    if (!IMPL_FORMAT_RE.test(blob)) {
        fail("<!-- IMPL: format --> marker not found");
    }
    console.log("  impl marker: IMPL: format present");

    // Assertion 4: <!-- PASS_COUNT: 4/4 -->
    const passMatch = blob.match(PASS_COUNT_RE);
    if (!passMatch) {
        fail("<!-- PASS_COUNT: n/4 --> marker not found");
    }
    if (passMatch[1] !== "4") {
        fail(`PASS_COUNT = ${passMatch[1]}/4 expected 4/4`);
    }
    console.log("  tests marker: PASS_COUNT = 4/4");

    // Assertion 5: extract the `calculate` code block from the member who
    // claimed that task, then run the 4 canonical cases.
    let calcCode: string | null = null;
    for (const content of outputs.values()) {
        if (IMPL_CALC_RE.test(content)) {
            const codeMatch = content.match(CODE_RE);
            if (codeMatch) {
                calcCode = codeMatch[1];
                break;
            }
        }
    }
    if (calcCode === null) {
        fail(
            "could not find a ```typescript code block in the member output claiming IMPL: calculate",
        );
    }

    let calc: (op: string, a: number, b: number) => number;
    try {
        calc = loadCalculate(calcCode);
    } catch (err) {
        fail(`calculate code failed to load: ${(err as Error).message}`);
    }

    for (let i = 0; i < CASES.length; i++) {
        const c = CASES[i];
        let result: number;
        try {
            result = calc(c.op, c.a, c.b);
        } catch (err) {
            fail(
                `calculate threw on case ${i} (${c.op} ${c.a},${c.b}): ${(err as Error).message}`,
            );
        }
        if (result !== c.expected) {
            fail(
                `case ${i}: calculate("${c.op}", ${c.a}, ${c.b}) = ${result}, expected ${c.expected}`,
            );
        }
    }
    console.log("  calculate: 4/4 cases pass");

    console.log("PASS: all markers present; calculate passes 4/4 cases.");
}

main();
