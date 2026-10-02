"""Static hygiene checks for Suite connector code (no Foundation import needed).

They pin three mistakes the Suite has made before:
1. calling the Foundation HTTP helper with a keyword it does not have (a TypeError at run time),
2. putting a credential into a URL query string (it reaches proxies, access logs and error text),
3. handing a token to git on the command line (visible to every local process).
"""

from __future__ import annotations

import ast
import re

from kit_target import target_root

ROOT = target_root()
ADVANCED = ROOT / "advanced"

# Keywords accepted by delta_extension_api.tooling.execute_http_request (after method, url).
HTTP_HELPER_KEYWORDS = {"headers", "params", "json", "auth", "should_check_address"}
CREDENTIAL_QUERY_NAMES = {"api_key", "apikey", "access_token", "token", "key", "secret", "password"}
QUERY_IN_URL = re.compile(r"[?&](?:api_?key|access_token|token|key|secret|password)=", re.I)


def _python_files():
    for path in sorted(ADVANCED.rglob("*.py")):
        yield path, ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def test_http_helper_calls_only_use_supported_keywords():
    problems = []
    for path, tree in _python_files():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _call_name(node) == "execute_http_request":
                for keyword in node.keywords:
                    if keyword.arg is not None and keyword.arg not in HTTP_HELPER_KEYWORDS:
                        problems.append(f"{path.relative_to(ROOT)}:{node.lineno} uses '{keyword.arg}='")
    assert not problems, problems


def test_credentials_never_travel_in_the_url_query():
    problems = []
    for path, tree in _python_files():
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and QUERY_IN_URL.search(node.value):
                problems.append(f"{path.relative_to(ROOT)}:{node.lineno} builds a credential query string")
            if isinstance(node, ast.Call):
                for keyword in node.keywords:
                    if keyword.arg == "params" and isinstance(keyword.value, ast.Dict):
                        for key in keyword.value.keys:
                            if isinstance(key, ast.Constant) and str(key.value).lower() in CREDENTIAL_QUERY_NAMES:
                                problems.append(
                                    f"{path.relative_to(ROOT)}:{node.lineno} sends '{key.value}' as a query parameter"
                                )
    assert not problems, problems


def test_git_token_is_passed_through_the_environment_not_argv():
    tree = ast.parse((ADVANCED / "connectors" / "github_auth.py").read_text(encoding="utf-8"))
    functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    argv_builder = ast.unparse(functions["build_git_auth"])
    assert "extraHeader" not in argv_builder and "Authorization" not in argv_builder
    env_builder = ast.unparse(functions["git_auth_env"])
    assert "GIT_CONFIG_VALUE_0" in env_builder and ".extraHeader" in env_builder
    # The header is scoped to the configured GitHub host, never the bare http.extraHeader key.
    assert "github_git_base()" in env_builder and "'http.extraHeader'" not in env_builder


def test_git_clone_and_pull_hand_git_the_token_environment():
    tree = ast.parse((ADVANCED / "connectors" / "provider_developer.py").read_text(encoding="utf-8"))
    authenticated = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "run_git" and node.args):
            continue
        words = {
            item.value
            for item in ast.walk(node.args[0])
            if isinstance(item, ast.Constant) and isinstance(item.value, str)
        }
        if words & {"clone", "pull"}:
            env = next((keyword.value for keyword in node.keywords if keyword.arg == "env"), None)
            assert env is not None and ast.unparse(env) == "git_auth_env(secrets)", ast.unparse(node)
            authenticated.append(words & {"clone", "pull"})
    assert {"clone"} in authenticated and {"pull"} in authenticated
