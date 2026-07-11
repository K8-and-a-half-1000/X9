"""Windows-native agent shell + subprocess-tool regression tests.

The agent's `bash` tool historically passed its command string to
asyncio.create_subprocess_shell, which on Windows means `cmd.exe /c`:
POSIX *and* PowerShell syntax both failed, and — worst — multi-line
commands silently executed only their first line (exit code 0). It now
routes through `powershell -File <temp .ps1>` on Windows
(src/agent_tools/subprocess_tools.py) so the model works in one
documented dialect.

Also covered here: the SelectorEventLoop fallback. Under
`uvicorn --reload` on Windows the serving loop cannot spawn asyncio
subprocesses (NotImplementedError) — the tools must fall back to a
blocking subprocess in a thread instead of erroring out.
"""
import asyncio
import os
import sys
import tempfile

import pytest

from src.agent_tools.subprocess_tools import BashTool, PythonTool

WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason="Windows shell semantics")


def _run_bash(command: str) -> dict:
    return asyncio.run(BashTool().execute(command, {"subproc_env": None}))


@WINDOWS_ONLY
def test_multiline_command_runs_all_lines():
    # cmd.exe /c ran only the first line of a multi-line command — silently.
    result = _run_bash("Write-Output first\nWrite-Output second")
    assert result["exit_code"] == 0
    assert "first" in result["output"]
    assert "second" in result["output"]


@WINDOWS_ONLY
def test_powershell_cmdlet_executes():
    result = _run_bash("(Get-Location).Path")
    assert result["exit_code"] == 0
    assert "is not recognized" not in result["output"]


@WINDOWS_ONLY
def test_native_exit_code_propagates():
    # `powershell -File` alone reports 0 for a failed native command; the
    # `exit $LASTEXITCODE` epilogue (powershell_script_text) propagates it.
    result = _run_bash("cmd /c exit 7")
    assert result["exit_code"] == 7


@WINDOWS_ONLY
def test_temp_script_is_cleaned_up():
    before = {f for f in os.listdir(tempfile.gettempdir()) if f.startswith("x9_shell_")}
    _run_bash("Write-Output done")
    after = {f for f in os.listdir(tempfile.gettempdir()) if f.startswith("x9_shell_")}
    assert after <= before


def test_selector_loop_fallback_still_runs(monkeypatch):
    """When the loop can't spawn asyncio subprocesses (SelectorEventLoop on
    Windows, e.g. uvicorn --reload), the tool falls back to blocking
    subprocess.run in a thread instead of surfacing NotImplementedError."""
    def _raise(*a, **k):
        raise NotImplementedError

    monkeypatch.setattr(asyncio, "create_subprocess_shell", _raise)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _raise)
    # `echo fallback-ok` is valid in PowerShell (alias of Write-Output) and sh.
    result = _run_bash("echo fallback-ok")
    assert result["exit_code"] == 0
    assert "fallback-ok" in result["output"]


def test_selector_loop_fallback_python_tool(monkeypatch):
    def _raise(*a, **k):
        raise NotImplementedError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _raise)
    result = asyncio.run(PythonTool().execute("print('py-fallback-ok')", {"subproc_env": None}))
    assert result["exit_code"] == 0
    assert "py-fallback-ok" in result["output"]


@WINDOWS_ONLY
def test_bg_launch_windows_powershell_wrapper(tmp_path, monkeypatch):
    """`#!bg` background jobs must run the same PowerShell dialect as the
    foreground shell tool, log cmdlet output (requires the hidden-console
    spawn — DETACHED_PROCESS silently drops it), and record the real native
    exit code (the `echo %ERRORLEVEL%> file` form wrote an empty file)."""
    import time

    from src import bg_jobs

    jobs_dir = tmp_path / "bg_jobs"
    jobs_dir.mkdir()
    monkeypatch.setattr(bg_jobs, "_JOBS_DIR", jobs_dir)
    monkeypatch.setattr(bg_jobs, "_STORE", tmp_path / "bg_jobs.json")

    rec = bg_jobs.launch("Write-Output bg-probe\ncmd /c exit 3", session_id="t")
    exit_path = rec["exit_path"]
    for _ in range(120):
        if os.path.exists(exit_path) and open(exit_path).read().strip():
            break
        time.sleep(0.25)
    log = open(rec["log_path"], encoding="utf-8", errors="replace").read()
    assert "bg-probe" in log
    assert open(exit_path).read().strip() == "3"


def test_tool_path_roots_include_platform_tempdir():
    """%TEMP% (Windows) / the platform temp dir must be an allowed file-tool
    root — the allowlist used to be POSIX-only (/tmp + $TMPDIR)."""
    from src.tool_execution import _resolve_tool_path, _tool_path_roots

    tmp_real = os.path.realpath(tempfile.gettempdir())
    assert tmp_real in _tool_path_roots()
    resolved = _resolve_tool_path(os.path.join(tmp_real, "x9_probe.txt"))
    assert resolved.startswith(tmp_real)
