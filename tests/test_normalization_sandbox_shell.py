from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "tools" / "normalization_sandbox.py"


class NormalizationSandboxShellTests(unittest.TestCase):
    def run_shell(
        self,
        root: Path,
        command: str,
        timeout_seconds: int = 5,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        env = {
            **os.environ,
            "READTAILOR_SANDBOX_ROOT": str(root),
            "SHELL_COMMAND": command,
            "SHELL_TIMEOUT_SECONDS": str(timeout_seconds),
        }
        completed = subprocess.run(
            ["python3", str(HELPER), "run-shell"],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 5,
            check=False,
        )
        payload = json.loads(completed.stdout) if completed.stdout else {}
        return completed, payload

    def test_runs_in_isolated_work_directory_with_sanitized_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            completed, payload = self.run_shell(
                root,
                "pwd; printf '%s' \"$HOME|$TMPDIR\"",
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(payload["exit_code"], 0)
            self.assertFalse(payload["timed_out"])
            stdout = str(payload["stdout"])
            self.assertIn(str(root / "work"), stdout)
            self.assertIn(f"{root / 'work'}|{root / 'work' / 'tmp'}", stdout)

    def test_kills_the_shell_process_group_at_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            started = time.monotonic()
            completed, payload = self.run_shell(
                Path(directory),
                "python3 -c 'import time; time.sleep(10)'",
                timeout_seconds=1,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(payload["timed_out"])
            self.assertLess(time.monotonic() - started, 5)

    def test_caps_captured_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed, payload = self.run_shell(
                Path(directory),
                "python3 -c 'print(\"x\" * 300000)'",
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(payload["truncated"]["stdout"])
            self.assertLessEqual(len(str(payload["stdout"]).encode()), 256 * 1024)


if __name__ == "__main__":
    unittest.main()
