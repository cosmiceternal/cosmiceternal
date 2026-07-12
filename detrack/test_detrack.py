"""Basic tests for detrack. Run: python3 -m pytest -q  (or python3 test_detrack.py)."""
import tempfile
from pathlib import Path

import detrack


def test_load_telemetry_hosts_nonempty_and_clean():
    hosts = detrack.load_telemetry_hosts()
    assert len(hosts) > 10
    assert all(" " not in h and not h.startswith("#") for h in hosts)
    assert "vortex.data.microsoft.com" in hosts


def test_audit_reports_hardware_as_not_addressable():
    findings = {f.name: f for f in detrack.audit()}
    me = findings["Intel Management Engine (ME/AMT)"]
    assert me.addressable is False
    psn = findings["CPU serial number (PSN)"]
    assert psn.addressable is False and psn.present is False


def test_hosts_block_is_wrapped_in_markers():
    block = detrack._hosts_block(["a.example.com", "b.example.com"])
    assert block.startswith(detrack.BLOCK_BEGIN)
    assert detrack.BLOCK_END in block
    assert "0.0.0.0 a.example.com" in block


def test_plan_generates_all_files_and_undo():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "out"
        detrack.plan(out)
        for rel in ("windows/apply.ps1", "windows/undo.ps1",
                    "windows/hosts-block.txt", "linux/apply.sh",
                    "linux/undo.sh", "REPORT.md"):
            assert (out / rel).exists(), f"missing {rel}"
        # apply must be paired with a real undo path
        assert "Remove-ItemProperty" in (out / "windows/undo.ps1").read_text()
        assert "AllowTelemetry" in (out / "windows/apply.ps1").read_text()
        # linux scripts must be executable
        assert (out / "linux/apply.sh").stat().st_mode & 0o111


def test_generated_powershell_has_balanced_literal_braces():
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "out"
        detrack.plan(out)
        for name in ("apply.ps1", "undo.ps1"):
            text = (out / "windows" / name).read_text()
            assert text.count("{") == text.count("}"), f"unbalanced braces in {name}"


if __name__ == "__main__":
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    sys.exit(1 if failed else 0)
