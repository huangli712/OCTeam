const ITEM_COUNT = 1_000_000;
const SWAP_COUNT = 10_000;
const SEED = 42;
const VALUE_LIMIT = 1_000_000_000;
const WARMUP_PASSES = 1;
const MEASURED_PASSES = 3;

type DatasetName = "RANDOM" | "NEARLY" | "REVERSE";

interface BenchmarkResult {
    readonly ok: boolean;
    readonly medianMs: number;
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function makeRandomDataset(): number[] {
    const next = mulberry32(SEED);
    const values = new Array<number>(ITEM_COUNT);
    for (let index = 0; index < ITEM_COUNT; index += 1) {
        values[index] = Math.floor(next() * VALUE_LIMIT);
    }
    return values;
}

function makeNearlyDataset(randomDataset: readonly number[]): number[] {
    const values = [...randomDataset].sort((left, right) => left - right);
    const next = mulberry32(SEED);
    for (let swap = 0; swap < SWAP_COUNT; swap += 1) {
        const left = Math.floor(next() * ITEM_COUNT);
        const right = Math.floor(next() * ITEM_COUNT);
        const value = values[left];
        values[left] = values[right];
        values[right] = value;
    }
    return values;
}

function makeReverseDataset(randomDataset: readonly number[]): number[] {
    return [...randomDataset].sort((left, right) => right - left);
}

function siftDown(values: number[], start: number, end: number): void {
    let root = start;
    while (true) {
        const leftChild = root * 2 + 1;
        if (leftChild > end) {
            return;
        }

        const rightChild = leftChild + 1;
        let swapIndex = root;
        if (values[swapIndex] < values[leftChild]) {
            swapIndex = leftChild;
        }
        if (rightChild <= end && values[swapIndex] < values[rightChild]) {
            swapIndex = rightChild;
        }
        if (swapIndex === root) {
            return;
        }

        const value = values[root];
        values[root] = values[swapIndex];
        values[swapIndex] = value;
        root = swapIndex;
    }
}

function heapSort(values: number[]): void {
    for (let start = Math.floor((values.length - 2) / 2); start >= 0; start -= 1) {
        siftDown(values, start, values.length - 1);
    }

    for (let end = values.length - 1; end > 0; end -= 1) {
        const value = values[end];
        values[end] = values[0];
        values[0] = value;
        siftDown(values, 0, end - 1);
    }
}

function matchesReference(values: readonly number[], reference: readonly number[]): boolean {
    if (values.length !== reference.length) {
        return false;
    }

    for (let index = 0; index < values.length; index += 1) {
        if (values[index] !== reference[index]) {
            return false;
        }
    }
    return true;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const value = sorted[middle];
    if (value === undefined) {
        throw new Error("Cannot compute median of an empty sample set");
    }
    return value;
}

function benchmarkDataset(name: DatasetName, dataset: readonly number[]): BenchmarkResult {
    const reference = [...dataset].sort((left, right) => left - right);
    let ok = true;
    const timings: number[] = [];

    for (let pass = 0; pass < WARMUP_PASSES + MEASURED_PASSES; pass += 1) {
        const copy = [...dataset];
        const start = performance.now();
        heapSort(copy);
        const elapsedMs = performance.now() - start;

        ok = ok && matchesReference(copy, reference);
        if (pass >= WARMUP_PASSES) {
            timings.push(elapsedMs);
        }
    }

    console.error(`${name}: ${timings.map((value) => value.toFixed(2)).join(", ")} ms`);
    return { ok, medianMs: median(timings) };
}

const randomDataset = makeRandomDataset();
const nearlyDataset = makeNearlyDataset(randomDataset);
const reverseDataset = makeReverseDataset(randomDataset);

const randomResult = benchmarkDataset("RANDOM", randomDataset);
const nearlyResult = benchmarkDataset("NEARLY", nearlyDataset);
const reverseResult = benchmarkDataset("REVERSE", reverseDataset);
const sortOk = randomResult.ok && nearlyResult.ok && reverseResult.ok;

console.log(`<!-- SORT_OK: ${sortOk ? "true" : "false"} -->`);
console.log(`<!-- TIME_RANDOM: ${randomResult.medianMs.toFixed(2)} -->`);
console.log(`<!-- TIME_NEARLY: ${nearlyResult.medianMs.toFixed(2)} -->`);
console.log(`<!-- TIME_REVERSE: ${reverseResult.medianMs.toFixed(2)} -->`);
