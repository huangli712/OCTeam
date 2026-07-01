const SIZE = 1_000_000;
const SWAPS = 10_000;
const SEED = 42;
const GAPS = [701, 301, 132, 57, 23, 10, 4, 1] as const;
const PASSES = 3;

function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function buildRandom(): number[] {
    const rand = lcg(SEED);
    const values = new Array<number>(SIZE);
    for (let i = 0; i < SIZE; i++) {
        values[i] = Math.floor(rand() * 1_000_000_000);
    }
    return values;
}

function buildNearly(sortedRandom: number[]): number[] {
    const values = sortedRandom.slice();
    const rand = lcg(SEED);
    for (let i = 0; i < SWAPS; i++) {
        const a = Math.floor(rand() * SIZE);
        const b = Math.floor(rand() * SIZE);
        const tmp = values[a];
        values[a] = values[b];
        values[b] = tmp;
    }
    return values;
}

function shellsort(values: number[]): void {
    for (const gap of GAPS) {
        for (let i = gap; i < values.length; i++) {
            const current = values[i];
            let j = i;
            while (j >= gap && values[j - gap] > current) {
                values[j] = values[j - gap];
                j -= gap;
            }
            values[j] = current;
        }
    }
}

function arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function median(values: number[]): number {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function measure(name: string, dataset: number[], reference: number[]): { ok: boolean; ms: number } {
    const times: number[] = [];
    let ok = true;

    for (let pass = 0; pass < PASSES; pass++) {
        const copy = dataset.slice();
        const start = performance.now();
        shellsort(copy);
        const elapsed = performance.now() - start;
        times.push(elapsed);
        ok = arraysEqual(copy, reference) && ok;
        console.error(`${name} pass ${pass + 1}: ${elapsed.toFixed(3)} ms ok=${ok}`);
    }

    return { ok, ms: median(times) };
}

const random = buildRandom();
const randomReference = random.slice().sort((a, b) => a - b);
const nearly = buildNearly(randomReference);
const nearlyReference = nearly.slice().sort((a, b) => a - b);
const reverse = randomReference.slice().reverse();
const reverseReference = reverse.slice().sort((a, b) => a - b);

const randomResult = measure("random", random, randomReference);
const nearlyResult = measure("nearly", nearly, nearlyReference);
const reverseResult = measure("reverse", reverse, reverseReference);
const sortOk = randomResult.ok && nearlyResult.ok && reverseResult.ok;

console.log(`<!-- SORT_OK: ${sortOk ? "true" : "false"} -->`);
console.log(`<!-- TIME_RANDOM: ${randomResult.ms.toFixed(3)} -->`);
console.log(`<!-- TIME_NEARLY: ${nearlyResult.ms.toFixed(3)} -->`);
console.log(`<!-- TIME_REVERSE: ${reverseResult.ms.toFixed(3)} -->`);
