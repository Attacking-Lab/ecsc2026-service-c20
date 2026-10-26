#!/usr/bin/env python3
"""Turn `pip-notice collect` output plus a reviewed decisions file into the
inputs `pip-notice select` runs on without prompting.

Every collected package must have a decision, and every license named in a
decision must be assessed in licenses.json; a new dependency or license fails
the run instead of slipping into the NOTICE unreviewed.
"""

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPDX_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+-]*")
SPDX_OPERATORS = {"AND", "OR", "WITH"}


def fail(message: str) -> None:
    print(f"resolve.py: {message}", file=sys.stderr)
    sys.exit(1)


def check_license(expression: str, assessed: dict, where: str) -> None:
    for token in SPDX_TOKEN.findall(expression):
        if token in SPDX_OPERATORS:
            continue
        verdict = assessed.get(token)
        if verdict is None:
            fail(f"{where}: license {token!r} is not assessed in licenses.json")
        if verdict["conforms"]:
            continue
        if "exempt" not in verdict:
            fail(f"{where}: license {token!r} does not conform to contract § 7 Abs. 1")
        print(f"resolve.py: warning: {where}: {token} is exempt: {verdict['exempt']}", file=sys.stderr)


def resolve_text(selectors: list[str], collected: list[str], where: str) -> str:
    texts = []
    for selector in selectors:
        if selector.startswith("pkg:"):
            needle = selector.removeprefix("pkg:")
            matches = [text for text in collected if needle in text]
            if len(matches) != 1:
                fail(f"{where}: {selector!r} matches {len(matches)} collected texts")
            texts.append(matches[0])
        else:
            texts.append((HERE / selector).read_text())
    return "\n\n".join(text.strip("\n") for text in texts)


def main() -> None:
    decisions_path, raw_path, fixed_path, selection_path = sys.argv[1:5]
    decisions = json.loads(Path(decisions_path).read_text())
    assessed = json.loads((HERE / "licenses.json").read_text())
    raw = json.loads(Path(raw_path).read_text())

    fixed: dict[str, dict] = {}
    selection: dict[str, dict] = {}
    seen = set()
    for key in sorted(raw):
        name = key.split("==", 1)[0]
        info = raw[key]
        decision = decisions["packages"].get(name)
        if decision is None:
            fail(f"{key}: no decision in {decisions_path}; review its license first")
        seen.add(name)

        license_name = decision["license"]
        check_license(license_name, assessed, key)
        if license_name in info["licenses"]:
            if len(set(info["licenses"])) > 1:
                selection.setdefault(key, {})["license_name"] = license_name
        else:
            info["licenses"] = [license_name]

        selectors = decision.get("texts")
        if selectors is not None:
            text = resolve_text(selectors, info["license_texts"], key)
            shipped = [t for t in info["license_texts"] if t.strip("\n") == text]
            if not shipped:
                info["license_texts"] = [text]
            elif len(set(info["license_texts"])) > 1:
                selection.setdefault(key, {})["license_file"] = shipped[0]
        elif len(set(info["license_texts"])) != 1:
            fail(f"{key}: {len(info['license_texts'])} collected texts; pick with 'texts'")

        if "author" in decision:
            info["author"] = decision["author"]
        fixed[key] = info

    for name in sorted(set(decisions["packages"]) - seen):
        print(f"resolve.py: warning: decision for {name} matches no package", file=sys.stderr)

    for key, extra in decisions.get("extra", {}).items():
        check_license(extra["license"], assessed, key)
        fixed[key] = {
            "author": extra.get("author"),
            "licenses": [extra["license"]],
            "license_texts": [resolve_text(extra["texts"], [], key)],
        }

    Path(fixed_path).write_text(json.dumps(fixed))
    Path(selection_path).write_text(json.dumps(selection))


if __name__ == "__main__":
    main()
