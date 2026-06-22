function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b !== 0) {
        const t = b;
        b = a % b;
        a = t;
    }
    return a;
}

// Test case: gcd(48, 18) = 6
console.log(gcd(48, 18) === 6 ? "PASS" : "FAIL");
