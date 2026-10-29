#!/usr/bin/env python3
"""Local hidden key intake only. Never contacts any service."""
import getpass
import os
import shutil
import sys
import tempfile


def main():
    if not sys.stdin.isatty():
        print("Please run this command in your local Terminal.", file=sys.stderr)
        return 1
    key = getpass.getpass("TypeSafe API Key (hidden input): ")
    if not key or len(key) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        print("Invalid key format; nothing saved.", file=sys.stderr)
        return 1
    directory = tempfile.mkdtemp(prefix="jev-key-", dir="/private/tmp")
    path = os.path.join(directory, "api-key")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(key)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        shutil.rmtree(directory)
        raise
    print("Saved locally. Send only this file path to Codex:")
    print(path)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled; no key saved.", file=sys.stderr)
        sys.exit(1)
