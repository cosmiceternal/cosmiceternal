#!/usr/bin/env python3
"""
detrack - an honest privacy-hardening / telemetry-reduction tool.

What this tool DOES:
  * Audits the current machine for tracking / telemetry mechanisms that are
    actually addressable in software (read-only, changes nothing).
  * Generates reviewable, reversible remediation scripts that reduce OS-level
    telemetry (primarily Windows) and randomize network identifiers.

What this tool DELIBERATELY DOES NOT do (because it is not physically possible
in software, no matter what a product claims):
  * "Remove" identifiers or management engines baked into CPU/chip silicon.
    - Modern Intel/AMD CPUs do not carry a serial number. The old Pentium III
      Processor Serial Number (1999) was off by default and removed from later
      CPUs entirely.
    - The Intel Management Engine (ME/AMT) is firmware on a co-processor. It
      can only be neutralized by reflashing the BIOS/SPI chip (me_cleaner +
      coreboot), which needs hardware access and can permanently brick the
      machine. That is out of scope for a userspace program, on purpose.

Design principles:
  * DRY-RUN / REVIEW BY DEFAULT. This tool never silently mutates your system.
    `audit` is read-only. `plan` writes scripts to a folder for YOU to read
    and run. Every generated change ships with an undo script and a backup.

Usage:
    python3 detrack.py audit
    python3 detrack.py plan --out ./detrack-out
    python3 detrack.py hardware-report
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
VERSION = "1.0.0"

# Markers wrapped around anything we add to shared files (like /etc/hosts) so
# that changes are unambiguous and trivially reversible.
BLOCK_BEGIN = "# >>> detrack telemetry block (BEGIN) >>>"
BLOCK_END = "# <<< detrack telemetry block (END) <<<"


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _c(text: str, color: str) -> str:
    """Colorize for a terminal; no-op if output is not a tty."""
    if not sys.stdout.isatty():
        return text
    codes = {"red": 31, "green": 32, "yellow": 33, "blue": 34, "bold": 1, "dim": 2}
    return f"\033[{codes[color]}m{text}\033[0m"


def _run(cmd: list[str]) -> tuple[int, str]:
    """Run a command read-only, returning (rc, combined_output). Never raises."""
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15, check=False
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def load_telemetry_hosts() -> list[str]:
    hosts: list[str] = []
    path = DATA / "windows_telemetry_hosts.txt"
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            hosts.append(line)
    return hosts


# --------------------------------------------------------------------------- #
# audit: read-only detection
# --------------------------------------------------------------------------- #
class Finding:
    def __init__(self, name: str, present: bool, addressable: bool, detail: str):
        self.name = name
        self.present = present
        self.addressable = addressable
        self.detail = detail


def _mac_addresses() -> list[tuple[str, str]]:
    """Return list of (interface, mac). Cross-platform, best effort."""
    out: list[tuple[str, str]] = []
    system = platform.system()
    if system in ("Linux", "Darwin"):
        base = Path("/sys/class/net")
        if base.exists():  # Linux
            for iface in sorted(p.name for p in base.iterdir()):
                addr = base / iface / "address"
                if addr.exists():
                    mac = addr.read_text().strip()
                    if mac and mac != "00:00:00:00:00:00":
                        out.append((iface, mac))
            return out
        rc, text = _run(["ifconfig"])  # macOS fallback
        if rc == 0:
            iface = "?"
            for line in text.splitlines():
                m = re.match(r"^(\w+):", line)
                if m:
                    iface = m.group(1)
                m = re.search(r"ether ([0-9a-f:]{17})", line)
                if m:
                    out.append((iface, m.group(1)))
    else:  # Windows
        node = uuid.getnode()
        mac = ":".join(f"{(node >> b) & 0xFF:02x}" for b in range(40, -1, -8))
        out.append(("primary", mac))
    return out


def audit() -> list[Finding]:
    findings: list[Finding] = []
    system = platform.system()

    # --- Intel Management Engine interface (hardware; NOT software-removable) -
    mei_present = any(Path(p).exists() for p in ("/dev/mei0", "/dev/mei"))
    cpu_is_intel = "intel" in platform.processor().lower() or _cpu_is_intel()
    findings.append(
        Finding(
            "Intel Management Engine (ME/AMT)",
            present=mei_present or cpu_is_intel,
            addressable=False,
            detail=(
                "Firmware co-processor in the chipset. Cannot be removed by any "
                "OS-level program. Neutralizing it requires reflashing the SPI "
                "chip (me_cleaner/coreboot) with hardware access, at real risk "
                "of bricking. Out of scope by design."
                + (" [/dev/mei present]" if mei_present else "")
            ),
        )
    )

    # --- CPU serial number (myth on modern chips) --------------------------- #
    findings.append(
        Finding(
            "CPU serial number (PSN)",
            present=False,
            addressable=False,
            detail=(
                "Not present on modern CPUs. The Pentium III PSN (1999) was off "
                "by default and dropped from later Intel CPUs. Nothing to remove."
            ),
        )
    )

    # --- MAC addresses (hardware id, but software-randomizable) ------------- #
    macs = _mac_addresses()
    findings.append(
        Finding(
            "Network MAC address(es)",
            present=bool(macs),
            addressable=True,
            detail=(
                "Hardware network identifiers. These CAN be randomized in "
                "software.\n      "
                + "\n      ".join(f"{i}: {m}" for i, m in macs)
                if macs
                else "No non-loopback interfaces detected."
            ),
        )
    )

    # --- Windows telemetry -------------------------------------------------- #
    if system == "Windows":
        rc, text = _run(["sc", "query", "DiagTrack"])
        running = "RUNNING" in text.upper()
        findings.append(
            Finding(
                "Windows DiagTrack service (telemetry)",
                present=rc == 0,
                addressable=True,
                detail="Connected User Experiences and Telemetry service. "
                + ("Currently RUNNING. " if running else "")
                + "Can be disabled reversibly.",
            )
        )
    else:
        findings.append(
            Finding(
                "Windows telemetry (DiagTrack etc.)",
                present=False,
                addressable=True,
                detail="Not applicable on this OS. Run `plan` to generate the "
                "Windows remediation scripts anyway if you are preparing them "
                "for a Windows machine.",
            )
        )

    # --- telemetry hosts already blocked in hosts file? --------------------- #
    hosts_file = _hosts_file_path()
    blocked = 0
    if hosts_file and hosts_file.exists():
        try:
            content = hosts_file.read_text(errors="ignore").lower()
            blocked = sum(1 for h in load_telemetry_hosts() if h.lower() in content)
        except OSError:
            pass
    findings.append(
        Finding(
            "Telemetry endpoints blocked in hosts file",
            present=blocked > 0,
            addressable=True,
            detail=f"{blocked} of {len(load_telemetry_hosts())} known telemetry "
            f"hostnames are already routed to a blackhole in {hosts_file}.",
        )
    )

    return findings


def _cpu_is_intel() -> bool:
    try:
        info = Path("/proc/cpuinfo").read_text(errors="ignore").lower()
        return "genuineintel" in info
    except OSError:
        return False


def _hosts_file_path() -> Path | None:
    if platform.system() == "Windows":
        root = os.environ.get("SystemRoot", r"C:\Windows")
        return Path(root) / "System32" / "drivers" / "etc" / "hosts"
    p = Path("/etc/hosts")
    return p if p.exists() else None


def print_audit(findings: list[Finding]) -> None:
    print(_c(f"\ndetrack {VERSION} — privacy audit", "bold"))
    print(_c(f"host: {platform.node()}  os: {platform.platform()}", "dim"))
    print(_c("(read-only; nothing on your system was changed)\n", "dim"))

    for f in findings:
        if not f.addressable:
            tag = _c("HARDWARE / not software-removable", "red")
        elif f.present:
            tag = _c("addressable", "yellow")
        else:
            tag = _c("clear / n-a", "green")
        dot = _c("●", "green" if (f.addressable and not f.present) else
                 ("yellow" if f.addressable else "red"))
        print(f"{dot} {_c(f.name, 'bold')}  [{tag}]")
        for line in f.detail.splitlines():
            print(f"      {_c(line.strip() if line == f.detail else line, 'dim')}")
        print()

    addressable = [f for f in findings if f.addressable and f.present]
    print(_c(f"{len(addressable)} item(s) can be reduced in software. "
             f"Run `detrack plan` to generate reversible scripts.\n", "blue"))


# --------------------------------------------------------------------------- #
# plan: generate reviewable, reversible remediation scripts
# --------------------------------------------------------------------------- #
def plan(out_dir: Path) -> None:
    out_dir = out_dir.resolve()
    (out_dir / "windows").mkdir(parents=True, exist_ok=True)
    (out_dir / "linux").mkdir(parents=True, exist_ok=True)

    hosts = load_telemetry_hosts()
    stamp = _dt.datetime.now().isoformat(timespec="seconds")

    _write(out_dir / "windows" / "hosts-block.txt", _hosts_block(hosts))
    _write(out_dir / "windows" / "apply.ps1", _win_apply(hosts, stamp))
    _write(out_dir / "windows" / "undo.ps1", _win_undo(stamp))
    _write(out_dir / "linux" / "apply.sh", _linux_apply(stamp), executable=True)
    _write(out_dir / "linux" / "undo.sh", _linux_undo(stamp), executable=True)
    _write(out_dir / "REPORT.md", _report(hosts, stamp))

    print(_c(f"\nGenerated reviewable remediation scripts in {out_dir}\n", "green"))
    print("  " + _c("READ THEM before running anything.", "bold"))
    print("  Windows (elevated PowerShell): .\\windows\\apply.ps1   (undo: undo.ps1)")
    print("  Linux   (root):                ./linux/apply.sh       (undo: undo.sh)")
    print("  Nothing has been changed on this machine.\n")


def _write(path: Path, content: str, executable: bool = False) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")
    if executable:
        path.chmod(0o755)


def _hosts_block(hosts: list[str]) -> str:
    lines = [BLOCK_BEGIN,
             "# Added by detrack. Remove everything between BEGIN/END to revert.",
             "# Routes Microsoft telemetry hostnames to a blackhole address."]
    for h in hosts:
        lines.append(f"0.0.0.0 {h}")
    lines.append(BLOCK_END)
    return "\n".join(lines) + "\n"


def _win_apply(hosts: list[str], stamp: str) -> str:
    # Scheduled telemetry tasks that are safe and standard to disable.
    tasks = [
        r"\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser",
        r"\Microsoft\Windows\Application Experience\ProgramDataUpdater",
        r"\Microsoft\Windows\Customer Experience Improvement Program\Consolidator",
        r"\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip",
        r"\Microsoft\Windows\Autochk\Proxy",
        r"\Microsoft\Windows\Feedback\Siuf\DmClient",
        r"\Microsoft\Windows\Feedback\Siuf\DmClientOnScenarioDownload",
    ]
    task_lines = "\n".join(
        f'Disable-Task "{t}"' for t in tasks
    )
    hosts_block = _hosts_block(hosts).rstrip("\n").replace("`", "``")
    return f"""# detrack Windows telemetry reduction — apply.ps1
# Generated: {stamp}
# Run in an ELEVATED PowerShell (Run as Administrator).
# Every change here is reversed by undo.ps1. A hosts backup is created.
#
# This is CONSERVATIVE: it disables the DiagTrack telemetry service, disables
# well-known telemetry scheduled tasks, sets the AllowTelemetry policy to the
# lowest value the edition honors, and blackholes telemetry hostnames.
# It does NOT touch Windows Update, the Store, Defender, or licensing.

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Continue'
Write-Host 'detrack: applying conservative telemetry reduction...' -ForegroundColor Cyan

# 1) Registry: request lowest telemetry level (0=Security, honored on Enterprise;
#    treated as 1=Basic on Home/Pro, still a reduction).
$dc = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection'
New-Item -Path $dc -Force | Out-Null
New-ItemProperty -Path $dc -Name 'AllowTelemetry' -PropertyType DWord -Value 0 -Force | Out-Null
Write-Host '  set AllowTelemetry policy = 0'

# 2) Service: stop and disable DiagTrack (Connected User Experiences and Telemetry).
foreach ($svc in @('DiagTrack','dmwappushservice')) {{
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s) {{
        Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
        Set-Service  -Name $svc -StartupType Disabled -ErrorAction SilentlyContinue
        Write-Host "  disabled service $svc"
    }}
}}

# 3) Scheduled tasks: disable known telemetry / CEIP tasks.
function Disable-Task([string]$path) {{
    $leaf   = Split-Path $path -Leaf
    $folder = Split-Path $path -Parent
    try {{
        Disable-ScheduledTask -TaskName $leaf -TaskPath ($folder + '\\') -ErrorAction Stop | Out-Null
        Write-Host "  disabled task $leaf"
    }} catch {{ }}
}}
{task_lines}

# 4) Hosts file: blackhole telemetry endpoints (backed up first).
$hosts = "$env:SystemRoot\\System32\\drivers\\etc\\hosts"
Copy-Item $hosts "$hosts.detrack.bak" -Force
$block = @'
{hosts_block}
'@
$existing = Get-Content $hosts -Raw -ErrorAction SilentlyContinue
if ($existing -notmatch [regex]::Escape('{BLOCK_BEGIN}')) {{
    Add-Content -Path $hosts -Value "`r`n$block`r`n"
    Write-Host '  added telemetry host blocks (backup: hosts.detrack.bak)'
}} else {{
    Write-Host '  hosts block already present; skipped'
}}

Write-Host 'detrack: done. Reboot to fully apply. Reverse with undo.ps1.' -ForegroundColor Green
"""


def _win_undo(stamp: str) -> str:
    tasks = [
        r"\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser",
        r"\Microsoft\Windows\Application Experience\ProgramDataUpdater",
        r"\Microsoft\Windows\Customer Experience Improvement Program\Consolidator",
        r"\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip",
        r"\Microsoft\Windows\Autochk\Proxy",
        r"\Microsoft\Windows\Feedback\Siuf\DmClient",
        r"\Microsoft\Windows\Feedback\Siuf\DmClientOnScenarioDownload",
    ]
    task_lines = "\n".join(f'Enable-Task "{t}"' for t in tasks)
    return f"""# detrack Windows telemetry reduction — undo.ps1
# Generated: {stamp}
# Reverses apply.ps1. Run in an ELEVATED PowerShell.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Continue'
Write-Host 'detrack: reverting telemetry changes...' -ForegroundColor Cyan

# 1) Registry: remove the policy value (returns to Windows default).
$dc = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection'
Remove-ItemProperty -Path $dc -Name 'AllowTelemetry' -ErrorAction SilentlyContinue
Write-Host '  removed AllowTelemetry policy value'

# 2) Services: restore to defaults (DiagTrack=Automatic, dmwappushservice=Manual).
Set-Service -Name 'DiagTrack' -StartupType Automatic -ErrorAction SilentlyContinue
Set-Service -Name 'dmwappushservice' -StartupType Manual -ErrorAction SilentlyContinue
Start-Service -Name 'DiagTrack' -ErrorAction SilentlyContinue
Write-Host '  restored services'

# 3) Scheduled tasks: re-enable.
function Enable-Task([string]$path) {{
    $leaf   = Split-Path $path -Leaf
    $folder = Split-Path $path -Parent
    try {{
        Enable-ScheduledTask -TaskName $leaf -TaskPath ($folder + '\\') -ErrorAction Stop | Out-Null
        Write-Host "  enabled task $leaf"
    }} catch {{ }}
}}
{task_lines}

# 4) Hosts file: restore from backup if present, else strip the detrack block.
$hosts = "$env:SystemRoot\\System32\\drivers\\etc\\hosts"
if (Test-Path "$hosts.detrack.bak") {{
    Copy-Item "$hosts.detrack.bak" $hosts -Force
    Write-Host '  restored hosts from backup'
}} else {{
    $content = Get-Content $hosts -Raw
    $pattern = '(?s)' + [regex]::Escape('{BLOCK_BEGIN}') + '.*?' + `
               [regex]::Escape('{BLOCK_END}') + '\\r?\\n?'
    $clean = [regex]::Replace($content, $pattern, '')
    Set-Content -Path $hosts -Value $clean -NoNewline
    Write-Host '  stripped detrack hosts block'
}}

Write-Host 'detrack: revert complete. Reboot to finish.' -ForegroundColor Green
"""


def _linux_apply(stamp: str) -> str:
    return f"""#!/usr/bin/env bash
# detrack Linux privacy hardening — apply.sh
# Generated: {stamp}
# Run as root (sudo). Reverse with undo.sh.
#
# On Linux there is no Microsoft-style telemetry to strip. The meaningful,
# reversible privacy win is randomizing your Wi-Fi/Ethernet MAC address so you
# are not trivially trackable across networks. This uses NetworkManager, which
# is standard on most desktops.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "detrack: please run as root (sudo ./apply.sh)" >&2
    exit 1
fi

CONF_DIR=/etc/NetworkManager/conf.d
CONF="$CONF_DIR/00-detrack-mac-randomization.conf"

if ! command -v nmcli >/dev/null 2>&1; then
    echo "detrack: NetworkManager (nmcli) not found. Skipping MAC randomization."
    echo "         For non-NetworkManager systems, use 'macchanger' per interface."
    exit 0
fi

mkdir -p "$CONF_DIR"
cat > "$CONF" <<'EOF'
# Added by detrack. Delete this file to revert.
# Randomizes MAC on both Wi-Fi and Ethernet, per-connection and on scan.
[connection]
wifi.cloned-mac-address=random
ethernet.cloned-mac-address=random

[device]
wifi.scan-rand-mac-address=yes
EOF

echo "detrack: wrote $CONF"
systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager 2>/dev/null || true
echo "detrack: MAC randomization enabled. Reconnect Wi-Fi to take effect."
echo "detrack: (Note: the Intel ME and any in-silicon identifiers are firmware/"
echo "         hardware and cannot be removed from software — by design.)"
"""


def _linux_undo(stamp: str) -> str:
    return f"""#!/usr/bin/env bash
# detrack Linux privacy hardening — undo.sh
# Generated: {stamp}
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    echo "detrack: please run as root (sudo ./undo.sh)" >&2
    exit 1
fi
CONF=/etc/NetworkManager/conf.d/00-detrack-mac-randomization.conf
if [[ -f "$CONF" ]]; then
    rm -f "$CONF"
    echo "detrack: removed $CONF"
    systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager 2>/dev/null || true
    echo "detrack: reverted MAC randomization. Reconnect Wi-Fi to take effect."
else
    echo "detrack: nothing to revert."
fi
"""


def _report(hosts: list[str], stamp: str) -> str:
    return f"""# detrack remediation plan

Generated: {stamp}
Tool version: {VERSION}

This folder contains **reviewable, reversible** scripts. Nothing runs
automatically. Read each script before executing it.

## What gets changed, and how to undo it

| Platform | apply | undo | backup |
|----------|-------|------|--------|
| Windows  | `windows/apply.ps1` | `windows/undo.ps1` | `hosts.detrack.bak` + registry value removal |
| Linux    | `linux/apply.sh` | `linux/undo.sh` | single conf file removal |

### Windows (`apply.ps1`) — conservative telemetry reduction
1. Sets the `AllowTelemetry` policy to the lowest value your edition honors.
2. Stops & disables the `DiagTrack` telemetry service (and `dmwappushservice`).
3. Disables {7} well-known telemetry / CEIP scheduled tasks.
4. Blackholes {len(hosts)} Microsoft telemetry hostnames in the `hosts` file
   (see `windows/hosts-block.txt`), after backing the file up.

It intentionally does **not** touch Windows Update, the Microsoft Store,
Defender, licensing, or time sync — blocking those breaks real functionality.

### Linux (`apply.sh`) — MAC address randomization
Adds a NetworkManager drop-in that randomizes your Wi-Fi and Ethernet MAC
addresses, so you are not trivially trackable across networks.

## What this tool will NOT do (and why no tool honestly can)

- **Intel Management Engine (ME/AMT):** firmware on a chipset co-processor.
  Removing/neutralizing it means reflashing the SPI chip (me_cleaner + coreboot)
  with physical hardware access, at real risk of permanently bricking the board.
  No program running on your OS can do this.
- **"CPU serial numbers":** modern CPUs do not have one. The Pentium III PSN
  (1999) was disabled by default and dropped from later chips.

Anything advertised as a one-click app that "removes hardware trackers from
your CPU" is misinformed or dishonest. The honest levers are the ones above.
"""


# --------------------------------------------------------------------------- #
# hardware-report: the honest explainer, standalone
# --------------------------------------------------------------------------- #
def hardware_report() -> None:
    print(_c("\nWhat can and cannot be 'de-tracked' in software\n", "bold"))
    rows = [
        ("Windows telemetry (DiagTrack, CEIP)", "YES",
         "Reducible & reversible. `detrack plan` generates the scripts."),
        ("MAC address", "YES",
         "Randomizable via NetworkManager / macchanger. Reversible."),
        ("Browser / app-level tracking", "YES (separate)",
         "Use uBlock Origin, container tabs, etc. Not this tool's job."),
        ("Intel Management Engine (ME/AMT)", "NO",
         "Firmware co-processor. Needs SPI reflash (me_cleaner/coreboot) + "
         "hardware access; can brick. Not doable from an app."),
        ("CPU serial number", "N/A",
         "Doesn't exist on modern CPUs. Nothing to remove."),
        ("TPM / hardware attestation", "NO",
         "Discrete/firmware security chip. Can be disabled in BIOS but not "
         "'removed' by software, and disabling it breaks BitLocker/Win11."),
    ]
    for name, can, why in rows:
        color = "green" if can.startswith("YES") else ("yellow" if can == "N/A" else "red")
        print(f"  {_c(can.ljust(14), color)} {_c(name, 'bold')}")
        print(f"                 {_c(why, 'dim')}\n")


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="detrack",
        description="Honest privacy-hardening / telemetry-reduction tool.",
    )
    parser.add_argument("--version", action="version", version=f"detrack {VERSION}")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("audit", help="Read-only scan of trackers/telemetry on this machine.")

    p_plan = sub.add_parser(
        "plan", help="Generate reviewable, reversible remediation scripts.")
    p_plan.add_argument("--out", default="./detrack-out", type=Path,
                        help="Output directory (default: ./detrack-out)")

    sub.add_parser("hardware-report",
                   help="Explain what is and isn't software-removable.")

    args = parser.parse_args(argv)

    if args.cmd == "audit":
        print_audit(audit())
    elif args.cmd == "plan":
        plan(args.out)
    elif args.cmd == "hardware-report":
        hardware_report()
    else:
        parser.print_help()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
