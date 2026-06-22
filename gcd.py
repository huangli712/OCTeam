def gcd(a, b):
    while b:
        a, b = b, a % b
    return a


if __name__ == "__main__":
    assert gcd(48, 18) == 6
    print("All tests passed")
