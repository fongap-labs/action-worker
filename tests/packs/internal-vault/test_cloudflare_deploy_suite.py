"""Cloudflare Workers release Brick: variable and secret handling, release order, health check and rollback.

Wrangler is never executed: every command goes through a recorder.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error

import pytest

from bricks import cfworkers_service_deploy as deploy

SECRET_NAMES = ["SERVICE_API_KEY", "SERVICE_WEBHOOK_SECRET"]


class Recorder:
    """Stands in for the Wrangler runner and records every command with its environment."""

    def __init__(self, deploy_output: str = "") -> None:
        self.calls: list[tuple[list[str], dict]] = []
        self.deploy_output = deploy_output
        self.secrets_seen: dict | None = None

    def __call__(self, cmd: list[str], env: dict) -> subprocess.CompletedProcess:
        self.calls.append((cmd, env))
        if "--secrets-file" in cmd:
            with open(cmd[cmd.index("--secrets-file") + 1], encoding="utf-8") as handle:
                self.secrets_seen = json.load(handle)
            return subprocess.CompletedProcess(cmd, 0, self.deploy_output, "")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def verbs(self) -> list[str]:
        names = []
        for cmd, _ in self.calls:
            if "--dry-run" in cmd:
                names.append("preflight")
            elif "migrations" in cmd:
                names.append("migrate")
            elif "rollback" in cmd:
                names.append("rollback")
            elif "deploy" in cmd:
                names.append("deploy")
        return names


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "service"
    (root / "migrations").mkdir(parents=True)
    (root / "migrations" / "0001_init.sql").write_text("CREATE TABLE IF NOT EXISTS t (id INTEGER);\n", encoding="utf-8")
    (root / "wrangler.toml").write_text(
        'main = "src/index.ts"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "service-db"\ndatabase_id = "x"\n',
        encoding="utf-8",
    )
    (root / ".worker-secrets").write_text("# runtime secrets\n" + "\n".join(SECRET_NAMES) + "\n", encoding="utf-8")
    (root / ".env.variables").write_text(
        "# variables\nSERVICE_MODE=fast\nSERVICE_ORIGINS=https://a.example,https://b.example\nSERVICE_REGION\n",
        encoding="utf-8",
    )
    return root


@pytest.fixture
def environment(monkeypatch):
    for name in SECRET_NAMES:
        monkeypatch.setenv(name, f"value-of-{name}")
    monkeypatch.setenv("SERVICE_REGION", "eu")
    monkeypatch.setattr(deploy, "wrangler_command", lambda: ["wrangler"])
    monkeypatch.setattr(deploy.time, "sleep", lambda _seconds: None)


def arguments(project, **extra) -> dict:
    return {"accountid": "account", "writetoken": "token", "project_dir": str(project), "project": "service",
            "vars_file": ".env.variables", **extra}


class FakeResponse:
    def __init__(self, body: dict) -> None:
        self._body = body

    def read(self) -> bytes:
        return json.dumps(self._body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None


def serve_health(monkeypatch, body: dict) -> list[str]:
    requested: list[str] = []

    def fake_urlopen(request, timeout):
        requested.append(request.full_url)
        return FakeResponse(body)

    monkeypatch.setattr(deploy.urllib.request, "urlopen", fake_urlopen)
    return requested


def test_vars_file_reads_fixed_and_external_values(project, environment):
    parsed = deploy._parse_vars_file(str(project / ".env.variables"))
    assert parsed == {
        "SERVICE_MODE": "fast",
        "SERVICE_ORIGINS": "https://a.example,https://b.example",
        "SERVICE_REGION": "eu",
    }


@pytest.mark.parametrize("content", ["1BAD=x\n", "SERVICE_MODE=a\nSERVICE_MODE=b\n", "SERVICE_MISSING\n"])
def test_vars_file_rejects_invalid_lines(tmp_path, environment, content):
    path = tmp_path / "vars"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError):
        deploy._parse_vars_file(str(path))


def test_vars_file_must_stay_inside_project(project, environment, monkeypatch):
    monkeypatch.setattr(deploy, "_run_cmd", Recorder())
    with pytest.raises(ValueError, match="inside project_dir"):
        deploy.execute(arguments(project, vars_file="../outside")).run()


def test_variable_defined_twice_or_named_like_a_secret_is_rejected(project, environment, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    with pytest.raises(ValueError, match="both vars_file and vars"):
        deploy.execute(arguments(project, vars={"SERVICE_MODE": "slow"})).run()
    with pytest.raises(ValueError, match="collide with secrets"):
        deploy.execute(arguments(project, vars={"SERVICE_API_KEY": "plain"})).run()
    assert recorder.calls == []


def test_missing_secret_stops_before_any_wrangler_call(project, environment, monkeypatch):
    monkeypatch.delenv("SERVICE_WEBHOOK_SECRET")
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    with pytest.raises(ValueError, match="SERVICE_WEBHOOK_SECRET"):
        deploy.execute(arguments(project)).run()
    assert recorder.calls == []


@pytest.mark.parametrize("extra", [{"domains": ["Not A Host"]}, {"schedules": ["every day"]}, {"health": "yes"}])
def test_invalid_deploy_options_are_rejected(project, extra):
    with pytest.raises(ValueError):
        deploy.execute(arguments(project, **extra))


def test_release_runs_preflight_then_migration_then_one_deploy(project, environment, monkeypatch):
    recorder = Recorder("Current Version ID: 11111111-2222-3333-4444-555555555555\n")
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    result = deploy.execute(arguments(project, vars={"SERVICE_BUILD": "abc"}, domains=["svc.example.com"],
                                       schedules=["0 3 * * *"])).run()

    assert recorder.verbs() == ["preflight", "migrate", "deploy"]
    assert result["artifacts"] == {"project": "service", "version_id": "11111111-2222-3333-4444-555555555555"}

    deploy_cmd = recorder.calls[-1][0]
    assert ["--domain", "svc.example.com"] == deploy_cmd[deploy_cmd.index("--domain"):deploy_cmd.index("--domain") + 2]
    assert ["--schedule", "0 3 * * *"] == deploy_cmd[deploy_cmd.index("--schedule"):deploy_cmd.index("--schedule") + 2]
    assert "SERVICE_BUILD:abc" in deploy_cmd
    assert "SERVICE_ORIGINS:https://a.example,https://b.example" in deploy_cmd
    assert not any(arg.startswith("SERVICE_API_KEY") for arg in deploy_cmd)


def test_secrets_travel_in_a_removed_file_and_never_in_the_wrangler_environment(project, environment, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    deploy.execute(arguments(project)).run()

    assert recorder.secrets_seen == {name: f"value-of-{name}" for name in SECRET_NAMES}
    deploy_cmd, deploy_env = recorder.calls[-1]
    secrets_path = deploy_cmd[deploy_cmd.index("--secrets-file") + 1]
    assert not os.path.exists(secrets_path)
    assert not os.path.exists(os.path.dirname(secrets_path))
    for _, env in recorder.calls:
        assert not set(SECRET_NAMES) & set(env)
        assert env["CLOUDFLARE_ACCOUNT_ID"] == "account" and env["CLOUDFLARE_API_TOKEN"] == "token"


def test_no_migration_without_sql_files(project, environment, monkeypatch):
    (project / "migrations" / "0001_init.sql").unlink()
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    deploy.execute(arguments(project)).run()
    assert recorder.verbs() == ["preflight", "deploy"]


def test_matching_health_check_passes(project, environment, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    requested = serve_health(monkeypatch, {"ok": True, "build": "abc"})
    result = deploy.execute(arguments(
        project, domains=["svc.example.com"],
        health={"path": "/health", "expect": {"ok": True, "build": "abc"}})).run()
    assert requested == ["https://svc.example.com/health"]
    assert result["artifacts"]["health"] == "ok"
    assert "rollback" not in recorder.verbs()


def test_stale_build_in_health_check_rolls_back_and_fails(project, environment, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    serve_health(monkeypatch, {"ok": True, "build": "previous"})
    with pytest.raises(RuntimeError, match="health check failed"):
        deploy.execute(arguments(
            project, domains=["svc.example.com"],
            health={"expect": {"ok": True, "build": "abc"}})).run()
    assert recorder.verbs()[-2:] == ["deploy", "rollback"]


def test_unreachable_health_endpoint_rolls_back(project, environment, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(deploy, "_run_cmd", recorder)

    def unreachable(_request, timeout):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(deploy.urllib.request, "urlopen", unreachable)
    with pytest.raises(RuntimeError, match="rollback attempted"):
        deploy.execute(arguments(project, domains=["svc.example.com"], health={"expect": {"ok": True}})).run()
    assert "rollback" in recorder.verbs()


def test_health_check_is_skipped_without_an_https_entry(project, environment, monkeypatch):
    recorder = Recorder("Deployed service\n")
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    result = deploy.execute(arguments(project, health={"expect": {"ok": True}})).run()
    assert "health" not in result["artifacts"]
    assert "rollback" not in recorder.verbs()


def test_health_entry_falls_back_to_the_first_https_line_of_the_deploy_output(project, environment, monkeypatch):
    recorder = Recorder("Deployed service triggers\n  https://service.example.workers.dev\n")
    monkeypatch.setattr(deploy, "_run_cmd", recorder)
    requested = serve_health(monkeypatch, {"ok": True})
    deploy.execute(arguments(project, health={"expect": {"ok": True}})).run()
    assert requested == ["https://service.example.workers.dev/health"]
