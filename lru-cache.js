class LRUCache {
    constructor(capacity) {
        this.capacity = capacity;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) {
            return -1;
        }
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    put(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.capacity) {
            const lru = this.cache.keys().next().value;
            this.cache.delete(lru);
        }
        this.cache.set(key, value);
    }
}

// Test 1: miss on empty cache
const c1 = new LRUCache(2);
console.log(c1.get(1) === -1 ? "PASS" : "FAIL");

// Test 2: basic put/get
const c2 = new LRUCache(2);
c2.put(1, 10);
c2.put(2, 20);
console.log(c2.get(1) === 10 && c2.get(2) === 20 ? "PASS" : "FAIL");

// Test 3: eviction of least-recently-used
const c3 = new LRUCache(2);
c3.put(1, "a");
c3.put(2, "b");
c3.get(1);            // make 1 recent
c3.put(3, "c");       // evicts 2
console.log(c3.get(2) === -1 && c3.get(1) === "a" && c3.get(3) === "c" ? "PASS" : "FAIL");
