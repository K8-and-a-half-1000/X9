import asyncio
import os
import subprocess
import sys
import tempfile
import time
import uuid
import collections
from typing import Optional, Callable, Awaitable, Tuple, Dict
from core.platform_compat import IS_WINDOWS, powershell_file_argv, powershell_script_text
from src.constants import MAX_OUTPUT_CHARS

DEFAULT_BASH_TIMEOUT = 60 * 60     # 1 hour
DEFAULT_PYTHON_TIMEOUT = 60 * 60

PROGRESS_INTERVAL_S = 2.0
PROGRESS_TAIL_LINES = 12

async def _run_subprocess_streaming(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Tuple[str, str, Optional[int], bool]:
    started = time.time()
    stdout_full: list[str] = []
    stderr_full: list[str] = []
    tail = collections.deque(maxlen=PROGRESS_TAIL_LINES)

    async def _reader(stream, full_buf, label: str):
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").rstrip("\n")
            full_buf.append(decoded)
            if label == "err":
                tail.append(f"! {decoded}")
            else:
                tail.append(decoded)

    async def _progress_emitter():
        await asyncio.sleep(PROGRESS_INTERVAL_S)
        while True:
            if progress_cb:
                try:
                    await progress_cb({
                        "elapsed_s": round(time.time() - started, 1),
                        "tail": "\n".join(list(tail)),
                    })
                except Exception:
                    pass
            await asyncio.sleep(PROGRESS_INTERVAL_S)

    rd_out = asyncio.create_task(_reader(proc.stdout, stdout_full, "out"))
    rd_err = asyncio.create_task(_reader(proc.stderr, stderr_full, "err"))
    prog_task = asyncio.create_task(_progress_emitter()) if progress_cb else None

    timed_out = False
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            pass
    except asyncio.CancelledError:
        try:
            proc.kill()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            pass
        for t in (rd_out, rd_err):
            t.cancel()
        if prog_task is not None:
            prog_task.cancel()
        raise
    finally:
        if prog_task is not None and not prog_task.done():
            prog_task.cancel()
            try:
                await prog_task
            except (asyncio.CancelledError, Exception):
                pass
        for t in (rd_out, rd_err):
            try:
                await asyncio.wait_for(t, timeout=1)
            except Exception:
                pass

    return (
        "\n".join(stdout_full),
        "\n".join(stderr_full),
        proc.returncode,
        timed_out,
    )

def _run_subprocess_blocking(
    args,
    *,
    shell: bool,
    env,
    cwd,
    timeout: float,
) -> Tuple[str, str, Optional[int], bool]:
    """``subprocess.run`` twin of ``_run_subprocess_streaming`` (same return
    shape, no progress streaming) for event loops that cannot spawn asyncio
    subprocesses — SelectorEventLoop on Windows, e.g. under
    ``uvicorn --reload``. ``subprocess.run`` kills the child on timeout."""
    try:
        p = subprocess.run(
            args, shell=shell, env=env, cwd=cwd,
            capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return (
            (e.stdout or b"").decode("utf-8", errors="replace"),
            (e.stderr or b"").decode("utf-8", errors="replace"),
            None,
            True,
        )
    return (
        p.stdout.decode("utf-8", errors="replace"),
        p.stderr.decode("utf-8", errors="replace"),
        p.returncode,
        False,
    )


async def _run_agent_subprocess(
    args,
    *,
    shell: bool,
    env,
    cwd,
    timeout: float,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Tuple[str, str, Optional[int], bool]:
    """Spawn an agent subprocess (``args`` is a command string when ``shell``,
    else an argv list) and collect its output.

    Falls back to a blocking run in a thread when the running event loop
    can't spawn asyncio subprocesses (NotImplementedError from
    SelectorEventLoop on Windows, e.g. under ``uvicorn --reload``) — progress
    streaming is lost there, but the command still runs.
    """
    try:
        if shell:
            proc = await asyncio.create_subprocess_shell(
                args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=cwd,
            )
        else:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=cwd,
            )
    except NotImplementedError:
        return await asyncio.to_thread(
            _run_subprocess_blocking, args,
            shell=shell, env=env, cwd=cwd, timeout=timeout,
        )
    return await _run_subprocess_streaming(proc, timeout=timeout, progress_cb=progress_cb)


class BashTool:
    async def execute(self, content: str, ctx: dict) -> dict:
        from src.tool_execution import agent_cwd, _truncate
        progress_cb = ctx.get("progress_cb")
        _subproc_env = ctx.get("subproc_env")
        script_path = None
        if IS_WINDOWS:
            # Run the command as a PowerShell script file. cmd.exe (the shell
            # create_subprocess_shell would use here) silently executes only
            # the FIRST line of a multi-line command; a -File script keeps
            # multi-line commands and quoting intact, and PowerShell is the
            # dialect the prompt tells the model to write on Windows.
            script_path = os.path.join(
                tempfile.gettempdir(), f"ad_shell_{uuid.uuid4().hex}.ps1"
            )
            with open(script_path, "w", encoding="utf-8-sig") as f:
                f.write(powershell_script_text(content))
            args, shell = powershell_file_argv(script_path), False
        else:
            args, shell = content, True
        try:
            stdout, stderr, rc, timed_out = await _run_agent_subprocess(
                args,
                shell=shell,
                env=_subproc_env,
                cwd=agent_cwd(),
                timeout=DEFAULT_BASH_TIMEOUT,
                progress_cb=progress_cb,
            )
        finally:
            if script_path:
                try:
                    os.unlink(script_path)
                except OSError:
                    pass
        if timed_out:
            return {"error": f"bash: timed out after {DEFAULT_BASH_TIMEOUT}s — process killed", "exit_code": 124, "stdout": _truncate(stdout, MAX_OUTPUT_CHARS), "stderr": _truncate(stderr, MAX_OUTPUT_CHARS)}
        output = stdout.rstrip()
        err = stderr.rstrip()
        if err:
            output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
        output = _truncate(output, MAX_OUTPUT_CHARS)
        return {"output": output or "(no output)", "exit_code": rc or 0}

class PythonTool:
    async def execute(self, content: str, ctx: dict) -> dict:
        from src.tool_execution import agent_cwd, _truncate
        progress_cb = ctx.get("progress_cb")
        _subproc_env = ctx.get("subproc_env")
        stdout, stderr, rc, timed_out = await _run_agent_subprocess(
            [(sys.executable or "python"), "-I", "-c", content],
            shell=False,
            env=_subproc_env,
            cwd=agent_cwd(),
            timeout=DEFAULT_PYTHON_TIMEOUT,
            progress_cb=progress_cb,
        )
        if timed_out:
            return {"error": f"python: timed out after {DEFAULT_PYTHON_TIMEOUT}s — process killed", "exit_code": 124, "stdout": _truncate(stdout, MAX_OUTPUT_CHARS), "stderr": _truncate(stderr, MAX_OUTPUT_CHARS)}
        output = stdout.rstrip()
        err = stderr.rstrip()
        if err:
            output = (output + "\nSTDERR: " + err).strip() if output else "STDERR: " + err
        output = _truncate(output, MAX_OUTPUT_CHARS)
        return {"output": output or "(no output)", "exit_code": rc or 0}
