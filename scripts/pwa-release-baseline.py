#!/usr/bin/env python3
"""Validate one public release snapshot before using its revision in CI."""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path


def read_release(path):
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict):
        raise ValueError("Release metadata must be an object")
    revision = data.get("buildId")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Release buildId must be a full lowercase Git SHA")
    timestamp = data.get("builtAt")
    if not isinstance(timestamp, str) or not timestamp.endswith("Z"):
        raise ValueError("Release builtAt must be a UTC timestamp")
    instant = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    if instant.tzinfo is None or instant.utcoffset() != timedelta(0):
        raise ValueError("Release builtAt must include UTC time")
    return revision, timestamp


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version_path")
    parser.add_argument("--expect")
    parser.add_argument("--github-output")
    args = parser.parse_args()
    try:
        revision, timestamp = read_release(args.version_path)
        if args.expect is not None:
            if not re.fullmatch(r"[0-9a-f]{40}", args.expect):
                raise ValueError("Expected revision must be a full lowercase Git SHA")
            if revision != args.expect:
                raise ValueError(f"Production changed: pinned {args.expect}, served {revision}")
        if args.github_output:
            with Path(args.github_output).open("a") as output:
                output.write(f"build_ref={revision}\n")
        print(json.dumps({"build_ref": revision, "built_at": timestamp}))
    except (ValueError, OSError) as error:
        print(f"Release baseline refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
