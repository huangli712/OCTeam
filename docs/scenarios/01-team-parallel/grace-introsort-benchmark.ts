import { performance } from "node:perf_hooks";

const DATASET_SIZE = 1_000_000;
const SWAP_COUNT = 10_000;
const INSERTION_THRESHOLD = 16;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 3;
const MAX_VALUE = 1_000_000_000;
const UINT32_DIVISOR = 4_294_967_296;

type DatasetName = "RANDOM" | "NEARLY" | "REVERSE";

type BenchmarkResult = {
    readonly name: DatasetName;
    readonly ok: boolean;
    readonly milliseconds: number;
};

function createPrng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / UINT32_DIVISOR;
    };
}

function generateRandom(): number[] {
    const next = createPrng(42);
    const values = new Array<number>(DATASET_SIZE);
    for (let index = 0; index < DATASET_SIZE; index += 1) {
        values[index] = Math.floor(next() * MAX_VALUE);
    }
    return values;
}

function generateNearly(random: readonly number[]): number[] {
    const values = [...random].sort((left, right) => left - right);
    const next = createPrng(42);
    for (let index = 0; index < SWAP_COUNT; index += 1) {
        const left = Math.floor(next() * DATASET_SIZE);
        const right = Math.floor(next() * DATASET_SIZE);
        swap(values, left, right);
    }
    return values;
}

function generateReverse(random: readonly number[]): number[] {
    return [...random].sort((left, right) => right - left);
}

function introsort(values: number[]): void {
    if (values.length < 2) {
        return;
    }

    const depthLimit = 2 * Math.floor(Math.log2(values.length));
    const stack: Array<{ readonly lo: number; readonly hi: number; readonly depth: number }> = [
        { lo: 0, hi: values.length - 1, depth: depthLimit },
    ];

    while (stack.length > 0) {
        const range = stack.pop();
        if (range === undefined) {
            continue;
        }

        const { lo, hi, depth } = range;
        if (hi - lo + 1 < INSERTION_THRESHOLD) {
            insertionSort(values, lo, hi);
            continue;
        }

        if (depth === 0) {
            heapSortRange(values, lo, hi);
            continue;
        }

        const pivot = partition(values, lo, hi);
        if (pivot - 1 - lo > hi - (pivot + 1)) {
            stack.push({ lo, hi: pivot - 1, depth: depth - 1 });
            stack.push({ lo: pivot + 1, hi, depth: depth - 1 });
        } else {
            stack.push({ lo: pivot + 1, hi, depth: depth - 1 });
            stack.push({ lo, hi: pivot - 1, depth: depth - 1 });
        }
    }
}

function partition(values: number[], lo: number, hi: number): number {
    const mid = lo + ((hi - lo) >> 1);
    medianOfThree(values, lo, mid, hi);
    const pivotValue = values[mid];
    swap(values, mid, hi - 1);

    let left = lo;
    let right = hi - 1;
    while (true) {
        left += 1;
        while (values[left] < pivotValue) {
            left += 1;
        }

        right -= 1;
        while (values[right] > pivotValue) {
            right -= 1;
        }

        if (left >= right) {
            break;
        }
        swap(values, left, right);
    }

    swap(values, left, hi - 1);
    return left;
}

function medianOfThree(values: number[], lo: number, mid: number, hi: number): void {
    if (values[mid] < values[lo]) {
        swap(values, lo, mid);
    }
    if (values[hi] < values[lo]) {
        swap(values, lo, hi);
    }
    if (values[hi] < values[mid]) {
        swap(values, mid, hi);
    }
}

function insertionSort(values: number[], lo: number, hi: number): void {
    for (let index = lo + 1; index <= hi; index += 1) {
        const current = values[index];
        let scan = index - 1;
        while (scan >= lo && values[scan] > current) {
            values[scan + 1] = values[scan];
            scan -= 1;
        }
        values[scan + 1] = current;
    }
}

function heapSortRange(values: number[], lo: number, hi: number): void {
    const length = hi - lo + 1;
    for (let start = Math.floor(length / 2) - 1; start >= 0; start -= 1) {
        siftDown(values, lo, start, length);
    }
    for (let end = length - 1; end > 0; end -= 1) {
        swap(values, lo, lo + end);
        siftDown(values, lo, 0, end);
    }
}

function siftDown(values: number[], offset: number, rootStart: number, length: number): void {
    let root = rootStart;
    while (true) {
        const leftChild = 2 * root + 1;
        if (leftChild >= length) {
            return;
        }

        const rightChild = leftChild + 1;
        let selectedChild = leftChild;
        if (rightChild < length && values[offset + rightChild] > values[offset + leftChild]) {
            selectedChild = rightChild;
        }

        if (values[offset + root] >= values[offset + selectedChild]) {
            return;
        }

        swap(values, offset + root, offset + selectedChild);
        root = selectedChild;
    }
}

function swap(values: number[], left: number, right: number): void {
    const temp = values[left];
    values[left] = values[right];
    values[right] = temp;
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function benchmark(name: DatasetName, dataset: readonly number[], reference: readonly number[]): BenchmarkResult {
    const samples: number[] = [];
    let ok = true;

    for (let pass = 0; pass < WARMUP_RUNS + MEASURED_RUNS; pass += 1) {
        const values = [...dataset];
        const start = performance.now();
        introsort(values);
        const elapsed = performance.now() - start;

        ok = ok && arraysEqual(values, reference);
        if (pass >= WARMUP_RUNS) {
            samples.push(elapsed);
        }
    }

    return {
        name,
        ok,
        milliseconds: median(samples),
    };
}

function main(): void {
    const random = generateRandom();
    const datasets: readonly { readonly name: DatasetName; readonly values: readonly number[] }[] = [
        { name: "RANDOM", values: random },
        { name: "NEARLY", values: generateNearly(random) },
        { name: "REVERSE", values: generateReverse(random) },
    ];

    const results = datasets.map((dataset) => {
        const reference = [...dataset.values].sort((left, right) => left - right);
        return benchmark(dataset.name, dataset.values, reference);
    });

    const randomResult = results.find((result) => result.name === "RANDOM");
    const nearlyResult = results.find((result) => result.name === "NEARLY");
    const reverseResult = results.find((result) => result.name === "REVERSE");
    if (randomResult === undefined || nearlyResult === undefined || reverseResult === undefined) {
        throw new Error("missing benchmark result");
    }

    const sortOk = results.every((result) => result.ok);
    console.log(`<!-- SORT_OK: ${sortOk ? "true" : "false"} -->`);
    console.log(`<!-- TIME_RANDOM: ${randomResult.milliseconds.toFixed(3)} -->`);
    console.log(`<!-- TIME_NEARLY: ${nearlyResult.milliseconds.toFixed(3)} -->`);
    console.log(`<!-- TIME_REVERSE: ${reverseResult.milliseconds.toFixed(3)} -->`);
}

main();
