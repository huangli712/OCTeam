import { performance } from "node:perf_hooks";

const DATASET_SIZE = 1_000_000;
const NEARLY_SWAP_COUNT = 10_000;
const INSERTION_SORT_THRESHOLD = 16;
const PRNG_SEED = 42;
const VALUE_LIMIT = 1_000_000_000;
const RUN_COUNT = 3;

type DatasetName = "RANDOM" | "NEARLY" | "REVERSE";

type BenchmarkResult = {
    readonly isValid: boolean;
    readonly medianMs: number;
};

function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function generateRandomDataset(): number[] {
    const random = mulberry32(PRNG_SEED);
    const values = new Array<number>(DATASET_SIZE);
    for (let index = 0; index < DATASET_SIZE; index += 1) {
        values[index] = Math.floor(random() * VALUE_LIMIT);
    }
    return values;
}

function generateNearlyDataset(randomValues: readonly number[]): number[] {
    const values = [...randomValues].sort((left, right) => left - right);
    const random = mulberry32(PRNG_SEED);
    for (let index = 0; index < NEARLY_SWAP_COUNT; index += 1) {
        const left = Math.floor(random() * DATASET_SIZE);
        const right = Math.floor(random() * DATASET_SIZE);
        const temp = values[left];
        values[left] = values[right];
        values[right] = temp;
    }
    return values;
}

function generateReverseDataset(randomValues: readonly number[]): number[] {
    return [...randomValues].sort((left, right) => right - left);
}

function insertionSort(values: number[], left: number, right: number): void {
    for (let index = left + 1; index <= right; index += 1) {
        const value = values[index];
        let cursor = index - 1;
        while (cursor >= left && values[cursor] > value) {
            values[cursor + 1] = values[cursor];
            cursor -= 1;
        }
        values[cursor + 1] = value;
    }
}

function medianOfThreeIndex(values: number[], left: number, middle: number, right: number): number {
    const leftValue = values[left];
    const middleValue = values[middle];
    const rightValue = values[right];

    if (leftValue < middleValue) {
        if (middleValue < rightValue) {
            return middle;
        }
        return leftValue < rightValue ? right : left;
    }

    if (leftValue < rightValue) {
        return left;
    }
    return middleValue < rightValue ? right : middle;
}

function swap(values: number[], left: number, right: number): void {
    const temp = values[left];
    values[left] = values[right];
    values[right] = temp;
}

function partition(values: number[], left: number, right: number): number {
    const middle = left + ((right - left) >> 1);
    const pivotIndex = medianOfThreeIndex(values, left, middle, right);
    const pivot = values[pivotIndex];
    swap(values, pivotIndex, right);

    let store = left;
    for (let index = left; index < right; index += 1) {
        if (values[index] < pivot) {
            swap(values, store, index);
            store += 1;
        }
    }
    swap(values, store, right);
    return store;
}

function quicksort(values: number[]): void {
    const stack: number[] = [0, values.length - 1];

    while (stack.length > 0) {
        const right = stack.pop();
        const left = stack.pop();
        if (left === undefined || right === undefined || left >= right) {
            continue;
        }

        if (right - left + 1 < INSERTION_SORT_THRESHOLD) {
            insertionSort(values, left, right);
            continue;
        }

        const pivot = partition(values, left, right);
        const leftSize = pivot - left;
        const rightSize = right - pivot;

        if (leftSize > rightSize) {
            stack.push(left, pivot - 1, pivot + 1, right);
        } else {
            stack.push(pivot + 1, right, left, pivot - 1);
        }
    }
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
    return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(dataset: readonly number[], reference: readonly number[], name: DatasetName): BenchmarkResult {
    const timings: number[] = [];
    let isValid = true;

    for (let run = 0; run < RUN_COUNT; run += 1) {
        const values = [...dataset];
        const start = performance.now();
        quicksort(values);
        const elapsed = performance.now() - start;
        timings.push(elapsed);

        if (!arraysEqual(values, reference)) {
            isValid = false;
            console.error(`${name} mismatch on run ${run + 1}`);
        }
    }

    return {
        isValid,
        medianMs: median(timings),
    };
}

const randomDataset = generateRandomDataset();
const nearlyDataset = generateNearlyDataset(randomDataset);
const reverseDataset = generateReverseDataset(randomDataset);

const randomReference = [...randomDataset].sort((left, right) => left - right);
const nearlyReference = [...nearlyDataset].sort((left, right) => left - right);
const reverseReference = [...reverseDataset].sort((left, right) => left - right);

const randomResult = benchmark(randomDataset, randomReference, "RANDOM");
const nearlyResult = benchmark(nearlyDataset, nearlyReference, "NEARLY");
const reverseResult = benchmark(reverseDataset, reverseReference, "REVERSE");
const sortOk = randomResult.isValid && nearlyResult.isValid && reverseResult.isValid;

console.log(`<!-- SORT_OK: ${sortOk ? "true" : "false"} -->`);
console.log(`<!-- TIME_RANDOM: ${randomResult.medianMs.toFixed(3)} -->`);
console.log(`<!-- TIME_NEARLY: ${nearlyResult.medianMs.toFixed(3)} -->`);
console.log(`<!-- TIME_REVERSE: ${reverseResult.medianMs.toFixed(3)} -->`);
