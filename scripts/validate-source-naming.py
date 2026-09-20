#!/usr/bin/env python3
"""Validate source naming for changed files without executing target code."""

from __future__ import annotations

import ast
import re
import subprocess
import sys
from pathlib import Path

BANNED = {"impl", "helper", "helpers", "common", "misc", "shared", "new", "final", "latest", "temp", "tmp"}
BOOL_HINTS = ("enabled", "disabled", "required", "available", "active", "visible", "writable", "replace")
BOOL_PREFIXES_PY = ("is_", "has_", "can_", "should_")
BOOL_PREFIXES_TS = ("is", "has", "can", "should")
SKIP_DIRS = {".git", ".venv", "node_modules", "target", "dist", "build", "__pycache__", ".pytest_cache"}


def parts(name: str) -> list[str]:
    return [part for part in re.split(r"[-_]+", name.strip("_-")) if part]


def camel_parts(name: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    return [part for part in re.split(r"[_\s]+", spaced.strip("_")) if part]


def is_test(path: Path) -> bool:
    return (
        "tests" in path.parts
        or path.name.startswith("test_")
        or ".test." in path.name
        or ".spec." in path.name
    )


def is_skipped(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts)


def bool_annotation(annotation: str) -> bool:
    return annotation in {
        "bool",
        "bool | None",
        "None | bool",
        "Optional[bool]",
        "typing.Optional[bool]",
    }


def changed_paths(root: Path, base: str, head: str) -> list[Path]:
    proc = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=ACMR", base, head],
        cwd=root,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    result: list[Path] = []
    for raw in proc.stdout.splitlines():
        path = Path(raw)
        if raw and (root / path).is_file() and not is_skipped(path):
            result.append(path)
    return result


def add(errors: list[str], path: Path, message: str) -> None:
    errors.append(f"{path.as_posix()}: {message}")


def check_file_name(errors: list[str], path: Path) -> None:
    suffix = path.suffix.lower()
    stem = path.stem

    if path.parts[:2] == (".github", "workflows") and suffix in {".yml", ".yaml"}:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+){0,2}", stem):
            add(errors, path, "workflow must be kebab-case with at most three segments")

    if suffix in {".sh", ".ps1"}:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+){0,2}", stem):
            add(errors, path, "shell file must be kebab-case with at most three segments")

    if suffix in {".py", ".rs"}:
        if stem in {"__init__", "main", "lib", "build"}:
            return
        if path.name.startswith("test_") and suffix == ".py":
            if len(parts(stem[5:])) > 3:
                add(errors, path, "pytest filename payload must have at most three segments")
            return
        tokens = parts(stem)
        if len(tokens) > 3:
            add(errors, path, "module filename must have at most three segments")
        bad = BANNED.intersection(tokens)
        if bad:
            add(errors, path, f"module filename contains banned term(s): {', '.join(sorted(bad))}")


def check_python(errors: list[str], root: Path, path: Path) -> None:
    if is_test(path):
        return
    try:
        tree = ast.parse((root / path).read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError:
        return

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        name = node.name.lstrip("_")
        if name and not (node.name.startswith("__") and node.name.endswith("__")):
            if not node.name.startswith("_") and BANNED.intersection(parts(name)):
                add(errors, path, f"function '{node.name}' contains a banned naming term")

        args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        if node.args.vararg:
            args.append(node.args.vararg)
        if node.args.kwarg:
            args.append(node.args.kwarg)

        for arg in args:
            arg_name = arg.arg.lstrip("_")
            if arg_name in {"self", "cls"}:
                continue
            annotation = ast.unparse(arg.annotation) if arg.annotation is not None else ""
            hinted_bool = not annotation and (
                arg_name in BOOL_HINTS
                or any(arg_name.endswith("_" + hint) for hint in BOOL_HINTS)
            )
            if (bool_annotation(annotation) or hinted_bool) and not arg_name.startswith(BOOL_PREFIXES_PY):
                add(errors, path, f"boolean parameter '{arg.arg}' must start with is_/has_/can_/should_")

        for child in ast.walk(node):
            if not isinstance(child, (ast.Assign, ast.AnnAssign)):
                continue
            value = child.value
            is_bool_value = isinstance(value, ast.Constant) and isinstance(value.value, bool)
            annotation = (
                ast.unparse(child.annotation)
                if isinstance(child, ast.AnnAssign) and child.annotation is not None
                else ""
            )
            if not (is_bool_value or bool_annotation(annotation)):
                continue
            targets = child.targets if isinstance(child, ast.Assign) else [child.target]
            for target in targets:
                variable = ""
                if isinstance(target, ast.Name):
                    variable = target.id
                elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self":
                    variable = target.attr
                variable = variable.lstrip("_")
                if variable and not variable.startswith(BOOL_PREFIXES_PY):
                    add(errors, path, f"boolean variable '{variable}' must start with is_/has_/can_/should_")


def parameter_block(text: str, start: int) -> str:
    open_index = text.find("(", start)
    if open_index < 0:
        return ""
    depth = 0
    for index in range(open_index, len(text)):
        char = text[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return text[open_index + 1 : index]
    return ""


def split_parameters(block: str) -> list[str]:
    params: list[str] = []
    start = 0
    round_depth = square_depth = brace_depth = angle_depth = 0
    for index, char in enumerate(block):
        if char == "(":
            round_depth += 1
        elif char == ")":
            round_depth = max(0, round_depth - 1)
        elif char == "[":
            square_depth += 1
        elif char == "]":
            square_depth = max(0, square_depth - 1)
        elif char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
        elif char == "<":
            angle_depth += 1
        elif char == ">":
            angle_depth = max(0, angle_depth - 1)
        elif char == "," and round_depth == square_depth == brace_depth == angle_depth == 0:
            params.append(block[start:index].strip())
            start = index + 1
    tail = block[start:].strip()
    if tail:
        params.append(tail)
    return params


def strip_rust_tests(text: str) -> str:
    marker = text.find("#[cfg(test)]")
    return text if marker < 0 else text[:marker]


def check_rust(errors: list[str], root: Path, path: Path) -> None:
    if is_test(path):
        return
    text = strip_rust_tests((root / path).read_text(encoding="utf-8"))
    fn_pattern = re.compile(
        r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)"
    )
    bool_param = re.compile(r"\b([a-z][a-z0-9_]*)\s*:\s*(?:Option\s*<\s*)?bool\s*>?")
    bool_local = re.compile(
        r"\blet\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*(?::\s*bool)?\s*=\s*(?:true|false)\b"
    )

    for match in fn_pattern.finditer(text):
        name = match.group(1)
        for param in split_parameters(parameter_block(text, match.start())):
            typed = bool_param.search(param)
            if typed and not typed.group(1).startswith(BOOL_PREFIXES_PY):
                add(
                    errors,
                    path,
                    f"boolean Rust parameter '{typed.group(1)}' must start with is_/has_/can_/should_",
                )

    for name in sorted(set(bool_local.findall(text))):
        if not name.startswith(BOOL_PREFIXES_PY):
            add(errors, path, f"boolean Rust variable '{name}' must start with is_/has_/can_/should_")


def check_ts_parameters(errors: list[str], path: Path, block: str) -> None:
    for param in split_parameters(block):
        typed = re.match(r"([A-Za-z][A-Za-z0-9]*)\??\s*:\s*boolean\b", param)
        default = re.match(r"([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:true|false)\b", param)
        match = typed or default
        if match and not match.group(1).startswith(BOOL_PREFIXES_TS):
            add(errors, path, f"boolean TypeScript parameter '{match.group(1)}' must start with is/has/can/should")


def check_typescript(errors: list[str], root: Path, path: Path) -> None:
    if is_test(path) or path.name.endswith(".d.ts"):
        return
    text = (root / path).read_text(encoding="utf-8")
    function_name = re.compile(
        r"(?m)^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z][A-Za-z0-9]*)"
    )
    arrow_name = re.compile(
        r"(?m)^\s*(?:export\s+)?const\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:async\s*)?\("
    )
    bool_local = re.compile(
        r"\b(?:let|const)\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:true|false)\b"
    )
    bool_state = re.compile(
        r"\bconst\s*\[\s*([A-Za-z][A-Za-z0-9]*)\s*,[^\]]+\]\s*=\s*useState(?:<boolean>)?\(\s*(?:true|false)\s*\)"
    )

    for pattern in (function_name, arrow_name):
        for match in pattern.finditer(text):
            name = match.group(1)
            check_ts_parameters(errors, path, parameter_block(text, match.start()))

    for name in bool_local.findall(text):
        if not name.startswith(BOOL_PREFIXES_TS):
            add(errors, path, f"boolean TypeScript variable '{name}' must start with is/has/can/should")

    for name in bool_state.findall(text):
        if not name.startswith(BOOL_PREFIXES_TS):
            add(errors, path, f"boolean TypeScript state '{name}' must start with is/has/can/should")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: validate-source-naming.py <base-sha> <head-sha>", file=sys.stderr)
        return 64

    root = Path.cwd()
    errors: list[str] = []
    files = changed_paths(root, sys.argv[1], sys.argv[2])

    for path in files:
        check_file_name(errors, path)
        suffix = path.suffix.lower()
        if suffix == ".py":
            check_python(errors, root, path)
        elif suffix == ".rs":
            check_rust(errors, root, path)
        elif suffix in {".ts", ".tsx"}:
            check_typescript(errors, root, path)

    if errors:
        print("source naming violations:", file=sys.stderr)
        for error in sorted(set(errors)):
            print(f"  {error}", file=sys.stderr)
        return 1

    print(f"source naming conventions passed ({len(files)} changed files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
