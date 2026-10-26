"""Strip comments (and Python docstrings) from the generated service tree.

Usage: strip_comments.py DIR

Python files lose every comment and docstring; the result must parse to the
same AST as the original minus its docstrings, or the build fails. HTML loses
<!-- --> blocks. Compose, Dockerfile, requirements, TOML and ignore files lose
whole-line # comments (and requirements their trailing ones). Everything else,
including the vendored third-party files and their licenses, is left alone.
"""

from __future__ import annotations

import ast
import io
import re
import sys
import tokenize
from pathlib import Path

LINE_COMMENT_FILES = {
    "compose.yaml",
    "Dockerfile",
    ".dockerignore",
    "requirements.txt",
    "pyproject.toml",
}
SKIP_DIRS = {"vendor", "node_modules", ".venv"}


def _docstring_nodes(tree: ast.AST) -> list[tuple[ast.Expr, list[ast.stmt]]]:
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                found.append((body[0], body))
    return found


def _without_docstrings(tree: ast.AST) -> str:
    for doc, body in _docstring_nodes(tree):
        body.remove(doc)
        if not body:
            body.append(ast.Pass())
    return ast.dump(tree)


def strip_python(source: str) -> str:
    lines = source.splitlines(keepends=True)
    drop: set[int] = set()  # 0-based lines to remove whole
    replace: dict[int, str] = {}  # 0-based line -> new text

    # A docstring that is its block's only statement becomes `pass`.
    for doc, body in _docstring_nodes(ast.parse(source)):
        first, last = doc.lineno - 1, doc.end_lineno - 1
        prefix = lines[first][: doc.col_offset]
        if len(body) == 1:
            replace[first] = prefix + "pass\n"
            drop.update(range(first + 1, last + 1))
        elif prefix.strip():
            raise ValueError(f"docstring shares line {doc.lineno} with code")
        else:
            drop.update(range(first, last + 1))

    # Comments: cut from the # to the end of the line; a line left blank goes.
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type != tokenize.COMMENT:
            continue
        row, col = tok.start[0] - 1, tok.start[1]
        if row == 0 and tok.string.startswith("#!"):
            continue
        if row in drop or row in replace:
            continue
        kept = lines[row][:col].rstrip()
        if kept:
            replace[row] = kept + "\n"
        else:
            drop.add(row)

    out = []
    for i, line in enumerate(lines):
        if i in drop:
            continue
        out.append(replace.get(i, line))
    result = "".join(out)

    if _without_docstrings(ast.parse(source)) != ast.dump(ast.parse(result)):
        raise ValueError("stripping changed the code")
    return result


def strip_html(source: str) -> str:
    return re.sub(r"[ \t]*<!--.*?-->[ \t]*\n?", "", source, flags=re.DOTALL)


def strip_line_comments(source: str, trailing: bool) -> str:
    out = []
    for line in source.splitlines(keepends=True):
        if line.lstrip().startswith("#"):
            continue
        if trailing and " #" in line:
            line = line.split(" #", 1)[0].rstrip() + "\n"
        out.append(line)
    return "".join(out)


def main(root: Path) -> None:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or SKIP_DIRS.intersection(path.relative_to(root).parts):
            continue
        if path.suffix == ".py":
            new = strip_python(path.read_text())
        elif path.suffix == ".html":
            new = strip_html(path.read_text())
        elif path.name in LINE_COMMENT_FILES:
            new = strip_line_comments(path.read_text(), trailing=path.name == "requirements.txt")
        else:
            continue
        path.write_text(new)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
