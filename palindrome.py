def is_palindrome(s):
    cleaned = "".join(s.split()).lower()
    return cleaned == cleaned[::-1]


if __name__ == "__main__":
    assert is_palindrome("Racecar") is True
    assert is_palindrome("A man a plan a canal Panama") is True
    print("All tests passed")
