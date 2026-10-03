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


def run(layout):
    mode = layout
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
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session", "--tools", "smoke_parent,smoke_child",
            "--extension", str(PACKAGE / "test/fixtures/smoke-provider.ts"),
            "--extension", str(PACKAGE / "src/index.ts"),
            "--model", "statusline-smoke/demo", "--tui-mode", layout,
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
            assert "Idle" not in startup, "Startup footer must not show Idle"
            assert "Until compact" not in startup, "Footer must not show removed compaction capacity"
            first = send("one\r", 1.2)
            expect(first, "complete.", "streaming response")
            expect(first, "Elapsed", "runtime elapsed")
            expect(first, "Turns 1", "model turn count")
            assert "Running 0s" not in first and "Done 0s" not in first, "Elapsed must not duplicate a status duration"
            expect(send("two\r", 1.2), "complete.", "second response")
            resize(160, 44)
            tool_text = send("tools\r", 0.8)
            expect(tool_text, "Tools 2 active", "nested tool lifecycle")
            input_text = drain(1.2)
            expect(input_text, "Smoke input", "real TUI prompt")
            expect(input_text, "Awaiting input", "UI wait overrides active tools")
            assert "No content" not in tool_text + input_text
            continuation = send("\r", 1.2)
            expect(continuation, "complete.", "tool continuation settles")
            expect(continuation, "Turns 2", "tool continuation does not reset run")
            expect(send("slow\r", 11.4), "No content", "default ten-second observation timeout")
            send("\x1b", 0.7)
            resumed = send("after cancel\r", 1.2)
            expect(resumed, "complete.", "new run after cancelling a slow stream")
            expect(resumed, "Turns 1", "new run resets the turn count")
            send("/smoke-fail-compact\r")
            expect(send("/compact\r", 1), "Compaction failed", "failed compaction restores runtime")
            compacted = send("/compact\r", 2)
            expect(compacted, "[??????????]?%", "unknown context after successful compaction")
            expect(compacted, "Compactions 1", "session compaction count")
            assert "Until compact" not in compacted, "Compaction must not restore removed capacity metrics"
            resize(100, 28)
            expect(send("/smoke-model\r"), "Smoke alternate(low)", "model and thinking change")
            expect(send("/smoke-theme\r"), "Smoke alternate", "live Pi theme change")
            expect(send("/statusline\r"), "Statusline settings", "configuration panel")
            select_item("Icons:")
            expect(send("\r"), "Icons: ascii", "draft icon preview")
            send("\x1b")
            assert not config_file.exists(), "Cancel must not persist"
            reopened = send("/statusline\r")
            expect(reopened, "Icons: nerd", "cancel preserved configuration")
            expect(reopened, "", "Powerline preview")
            assert "Preset:" not in reopened, "Only one layout: no preset selector"
            select_item("Context display:")
            expect(send("\r"), "?/200k", "switch to text preview")
            expect(send("\r"), "[??????????]?%", "unknown usage in bar preview")
            select_item("Save and apply globally")
            send("\r", 0.5)
            save_deadline = time.monotonic() + 5
            while not config_file.exists() and time.monotonic() < save_deadline:
                drain(0.1)
            assert config_file.exists(), f"{mode}: configuration save did not complete"
            saved_config = json.loads(config_file.read_text())
            assert saved_config["preset"] == "powerline"
            assert saved_config["contextDisplay"] == "bar"
            assert saved_config["icons"] == "nerd"
            assert saved_config["modelDisplay"] == "name"
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
    for layout in ("regular", "fullscreen"):
        run(layout)
