"""Offline Pi integration smoke. Requires Python 3, POSIX PTYs and Pi on PATH."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time


PACKAGE = Path(__file__).resolve().parents[1]
ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07)|\x1b\[[0-?]*[ -/]*[@-~]")


def run(mode):
    with tempfile.TemporaryDirectory(prefix="pi-statusline-pty-") as directory:
        root = Path(directory)
        agent = root / "agent"
        config_file = agent / "extensions" / "pi-statusline" / "config.json"
        project = root / "project"
        agent.mkdir()
        project.mkdir()
        (agent / "settings.json").write_text(json.dumps({
            "quietStartup": True,
            "theme": "dark",
            "defaultProvider": "statusline-smoke",
            "defaultModel": "demo",
            "defaultThinkingLevel": "high",
            "compaction": {"keepRecentTokens": 1},
            "enableAnalytics": False,
            "enableInstallTelemetry": False,
        }))
        executable = shutil.which("pi")
        if not executable:
            raise RuntimeError("Pi must be installed or on PATH via npm run smoke")
        master, slave = pty.openpty()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
        process = subprocess.Popen([
            executable, "--offline", "--no-approve", "--no-extensions",
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session",
            "--extension", str(PACKAGE / "test/fixtures/smoke-provider.ts"),
            "--extension", str(PACKAGE / "src/index.ts"),
            "--model", "statusline-smoke/demo", "--tui-mode", mode,
        ], cwd=project, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
            env={**os.environ, "PI_CODING_AGENT_DIR": str(agent), "TERM": "xterm-256color"})
        os.close(slave)
        output = bytearray()

        def drain(seconds=0.3):
            end = time.monotonic() + seconds
            start = len(output)
            while time.monotonic() < end:
                if select.select([master], [], [], min(0.05, max(0, end - time.monotonic())))[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output.extend(data)
            return ANSI.sub("", output[start:].decode("utf8", "replace")).replace("\r", "")

        def send(text, seconds=0.3):
            os.write(master, text.encode())
            return drain(seconds)

        def expect(text, marker, step):
            if marker not in text:
                raise AssertionError(f"{mode}: {step}: missing {marker!r}\n{text[-2500:]}")
            print(f"PASS {mode}: {step}", flush=True)

        def select_item(label):
            for _ in range(30):
                if f"→ {label}" in send("\x1b[B", 0.1):
                    return
            raise AssertionError(f"{mode}: settings item not found: {label}")

        def resize(columns, rows):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            os.killpg(process.pid, signal.SIGWINCH)
            return drain()

        try:
            startup = drain(2)
            expect(startup, "Smoke demo(high)", "native footer with inline thinking")
            expect(startup, "[░░░░░░░░░░]0%", "bar mode enabled by default")
            assert "$ 0.000" not in startup, "Default footer must not show the cost segment"
            expect(send("one\r", 1.2), "complete.", "streaming response")
            expect(send("two\r", 1.2), "complete.", "second response")
            expect(send("/compact\r", 2), "[??????????]?%", "unknown context after successful compaction")
            expect(send("/smoke-model\r"), "Smoke alternate(low)", "model and thinking change")
            expect(send("/smoke-theme\r"), "Smoke alternate", "live Pi theme change")
            expect(send("/statusline\r"), "Statusline settings", "configuration panel")
            expect(send("\r"), "Preset: minimal", "draft preset preview")
            send("\x1b")
            assert not config_file.exists(), "Cancel must not persist"
            expect(send("/statusline\r"), "Preset: cometix", "cancel preserved configuration")
            send("\r")
            expect(send("\r"), "Preset: powerline", "Powerline preview")
            select_item("Context display:")
            expect(send("\r"), "?/200k", "switch to text preview")
            expect(send("\r"), "[??????????]?%", "unknown usage in bar preview")
            select_item("Save and apply globally")
            send("\r", 0.5)
            saved_config = json.loads(config_file.read_text())
            assert saved_config["preset"] == "powerline"
            assert saved_config["contextDisplay"] == "bar"
            visible = [item["id"] for item in saved_config["segments"] if item["enabled"] and item["id"] != "thinking"]
            assert visible[:2] == ["model", "context"]
            assert not (agent / "statusline.json").exists(), "Save must not recreate the old configuration path"
            print(f"PASS {mode}: atomic configuration save", flush=True)
            resize(40, 18)
            expect(send("/statusline\r"), "Statusline settings", "40-column / 18-row panel")
            send("\x1b")
            resize(120, 32)
            expect(send("/statusline off\r"), "(auto)", "native footer restoration")
            expect(send("/statusline on\r"), "", "re-enable custom footer")
            expect(send("/reload\r", 2), "Reloaded", "extension reload")
            fresh = send("/new\r", 1)
            expect(fresh, "[░░░░░░░░░░]0%", "new session resets context bar")
            assert "$ 0.000" not in fresh, "Cost stays hidden in saved presets"
            send("\x04")
            process.wait(timeout=5)
            assert process.returncode == 0, f"Pi exited with {process.returncode}"
            text = output.decode("utf8", "replace")
            assert "Extension error" not in text and "TypeError" not in text
        finally:
            Path(f"/tmp/pi-statusline-pty-{mode}.log").write_bytes(output)
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
            os.close(master)


if __name__ == "__main__":
    for mode in ("regular", "fullscreen"):
        run(mode)
