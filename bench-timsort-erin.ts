const DATASET_SIZE = 1_000_000;
const SWAP_COUNT = 10_000;
const SEED = 42;
const MIN_GALLOP = 7;
const WARMUP_PASSES = 1;
const MEASURE_PASSES = 3;

type DatasetName = "random" | "nearly" | "reverse";

interface TimRun {
    base: number;
    length: number;
}

interface Dataset {
    readonly name: DatasetName;
    readonly values: readonly number[];
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

function computeMinRun(length: number): number {
    let remaining = length;
    let carry = 0;
    while (remaining >= 64) {
        carry |= remaining & 1;
        remaining >>= 1;
    }
    return remaining + carry;
}

function binaryInsertionSort(values: number[], start: number, end: number, sortedEnd: number): void {
    for (let index = sortedEnd; index < end; index += 1) {
        const current = values[index];
        let left = start;
        let right = index;
        while (left < right) {
            const mid = left + ((right - left) >> 1);
            if (current < values[mid]) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        for (let move = index; move > left; move -= 1) {
            values[move] = values[move - 1];
        }
        values[left] = current;
    }
}

function reverseRange(values: number[], start: number, endExclusive: number): void {
    let left = start;
    let right = endExclusive - 1;
    while (left < right) {
        const temp = values[left];
        values[left] = values[right];
        values[right] = temp;
        left += 1;
        right -= 1;
    }
}

function countRun(values: number[], start: number, end: number): number {
    if (start + 1 === end) {
        return 1;
    }
    let runEnd = start + 2;
    if (values[runEnd - 1] < values[start]) {
        while (runEnd < end && values[runEnd] < values[runEnd - 1]) {
            runEnd += 1;
        }
        reverseRange(values, start, runEnd);
        return runEnd - start;
    }
    while (runEnd < end && values[runEnd] >= values[runEnd - 1]) {
        runEnd += 1;
    }
    return runEnd - start;
}

function gallopLeft(key: number, values: number[], base: number, length: number): number {
    let left = 0;
    let right = length;
    while (left < right) {
        const mid = left + ((right - left) >> 1);
        if (values[base + mid] < key) {
            left = mid + 1;
        } else {
            right = mid;
        }
    }
    return left;
}

function gallopRight(key: number, values: number[], base: number, length: number): number {
    let left = 0;
    let right = length;
    while (left < right) {
        const mid = left + ((right - left) >> 1);
        if (key < values[base + mid]) {
            right = mid;
        } else {
            left = mid + 1;
        }
    }
    return left;
}

function mergeRuns(values: number[], first: TimRun, second: TimRun): TimRun {
    let firstBase = first.base;
    let firstLength = first.length;
    let secondBase = second.base;
    let secondLength = second.length;

    const firstSkip = gallopRight(values[secondBase], values, firstBase, firstLength);
    firstBase += firstSkip;
    firstLength -= firstSkip;
    if (firstLength === 0) {
        return { base: first.base, length: first.length + second.length };
    }

    const secondKeep = gallopLeft(values[firstBase + firstLength - 1], values, secondBase, secondLength);
    secondLength = secondKeep;
    if (secondLength === 0) {
        return { base: first.base, length: first.length + second.length };
    }

    if (firstLength <= secondLength) {
        mergeLow(values, firstBase, firstLength, secondBase, secondLength);
    } else {
        mergeHigh(values, firstBase, firstLength, secondBase, secondLength);
    }
    return { base: first.base, length: first.length + second.length };
}

function mergeLow(values: number[], firstBase: number, firstLength: number, secondBase: number, secondLength: number): void {
    const temp = values.slice(firstBase, firstBase + firstLength);
    let tempIndex = 0;
    let secondIndex = secondBase;
    let dest = firstBase;
    const tempEnd = firstLength;
    const secondEnd = secondBase + secondLength;
    let firstWins = 0;
    let secondWins = 0;

    while (tempIndex < tempEnd && secondIndex < secondEnd) {
        if (values[secondIndex] < temp[tempIndex]) {
            values[dest] = values[secondIndex];
            secondIndex += 1;
            secondWins += 1;
            firstWins = 0;
        } else {
            values[dest] = temp[tempIndex];
            tempIndex += 1;
            firstWins += 1;
            secondWins = 0;
        }
        dest += 1;

        if (firstWins >= MIN_GALLOP) {
            const count = gallopRight(values[secondIndex], temp, tempIndex, tempEnd - tempIndex);
            for (let offset = 0; offset < count; offset += 1) {
                values[dest + offset] = temp[tempIndex + offset];
            }
            dest += count;
            tempIndex += count;
            firstWins = 0;
        } else if (secondWins >= MIN_GALLOP) {
            const count = gallopLeft(temp[tempIndex], values, secondIndex, secondEnd - secondIndex);
            for (let offset = 0; offset < count; offset += 1) {
                values[dest + offset] = values[secondIndex + offset];
            }
            dest += count;
            secondIndex += count;
            secondWins = 0;
        }
    }

    while (tempIndex < tempEnd) {
        values[dest] = temp[tempIndex];
        dest += 1;
        tempIndex += 1;
    }
}

function mergeHigh(values: number[], firstBase: number, firstLength: number, secondBase: number, secondLength: number): void {
    const temp = values.slice(secondBase, secondBase + secondLength);
    let firstIndex = firstBase + firstLength - 1;
    let tempIndex = secondLength - 1;
    let dest = secondBase + secondLength - 1;
    let firstWins = 0;
    let secondWins = 0;

    while (firstIndex >= firstBase && tempIndex >= 0) {
        if (temp[tempIndex] < values[firstIndex]) {
            values[dest] = values[firstIndex];
            firstIndex -= 1;
            firstWins += 1;
            secondWins = 0;
        } else {
            values[dest] = temp[tempIndex];
            tempIndex -= 1;
            secondWins += 1;
            firstWins = 0;
        }
        dest -= 1;

        if (firstWins >= MIN_GALLOP) {
            const count = firstIndex - firstBase + 1 - gallopRight(temp[tempIndex], values, firstBase, firstIndex - firstBase + 1);
            for (let offset = 0; offset < count; offset += 1) {
                values[dest - offset] = values[firstIndex - offset];
            }
            dest -= count;
            firstIndex -= count;
            firstWins = 0;
        } else if (secondWins >= MIN_GALLOP) {
            const count = tempIndex + 1 - gallopLeft(values[firstIndex], temp, 0, tempIndex + 1);
            for (let offset = 0; offset < count; offset += 1) {
                values[dest - offset] = temp[tempIndex - offset];
            }
            dest -= count;
            tempIndex -= count;
            secondWins = 0;
        }
    }

    while (tempIndex >= 0) {
        values[dest] = temp[tempIndex];
        dest -= 1;
        tempIndex -= 1;
    }
}

function collapseRuns(values: number[], stack: TimRun[], force: boolean): void {
    while (stack.length > 1) {
        const n = stack.length - 2;
        const x = n > 0 ? stack[n - 1].length : Number.POSITIVE_INFINITY;
        const y = stack[n].length;
        const z = stack[n + 1].length;
        if (!force && x > y + z && y > z) {
            break;
        }
        const mergeAt = x < z ? n - 1 : n;
        const merged = mergeRuns(values, stack[mergeAt], stack[mergeAt + 1]);
        stack.splice(mergeAt, 2, merged);
    }
}

function timSort(values: number[]): void {
    const length = values.length;
    if (length < 2) {
        return;
    }

    const minRun = computeMinRun(length);
    const stack: TimRun[] = [];
    let current = 0;
    while (current < length) {
        let runLength = countRun(values, current, length);
        const forcedLength = Math.min(minRun, length - current);
        if (runLength < forcedLength) {
            binaryInsertionSort(values, current, current + forcedLength, current + runLength);
            runLength = forcedLength;
        }
        stack.push({ base: current, length: runLength });
        collapseRuns(values, stack, false);
        current += runLength;
    }
    collapseRuns(values, stack, true);
}

function makeRandomDataset(): number[] {
    const random = mulberry32(SEED);
    const values = new Array<number>(DATASET_SIZE);
    for (let index = 0; index < DATASET_SIZE; index += 1) {
        values[index] = Math.floor(random() * 1_000_000_000);
    }
    return values;
}

function makeDatasets(): Dataset[] {
    const random = makeRandomDataset();
    const nearly = random.slice().sort((left, right) => left - right);
    const swapRandom = mulberry32(SEED);
    for (let index = 0; index < SWAP_COUNT; index += 1) {
        const first = Math.floor(swapRandom() * DATASET_SIZE);
        const second = Math.floor(swapRandom() * DATASET_SIZE);
        const temp = nearly[first];
        nearly[first] = nearly[second];
        nearly[second] = temp;
    }
    const reverse = random.slice().sort((left, right) => right - left);
    return [
        { name: "random", values: random },
        { name: "nearly", values: nearly },
        { name: "reverse", values: reverse },
    ];
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
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(dataset: Dataset): { readonly ok: boolean; readonly ms: number } {
    const reference = dataset.values.slice().sort((left, right) => left - right);
    const timings: number[] = [];
    let ok = true;
    for (let pass = 0; pass < WARMUP_PASSES + MEASURE_PASSES; pass += 1) {
        const candidate = dataset.values.slice();
        const start = performance.now();
        timSort(candidate);
        const elapsed = performance.now() - start;
        ok = ok && arraysEqual(candidate, reference);
        if (pass >= WARMUP_PASSES) {
            timings.push(elapsed);
        }
    }
    return { ok, ms: median(timings) };
}

const datasets = makeDatasets();
const randomResult = benchmark(datasets[0]);
const nearlyResult = benchmark(datasets[1]);
const reverseResult = benchmark(datasets[2]);
const sortOk = randomResult.ok && nearlyResult.ok && reverseResult.ok;

console.log(`<!-- SORT_OK: ${sortOk ? "true" : "false"} -->`);
console.log(`<!-- TIME_RANDOM: ${randomResult.ms.toFixed(3)} -->`);
console.log(`<!-- TIME_NEARLY: ${nearlyResult.ms.toFixed(3)} -->`);
console.log(`<!-- TIME_REVERSE: ${reverseResult.ms.toFixed(3)} -->`);
