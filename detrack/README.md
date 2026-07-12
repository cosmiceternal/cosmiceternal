# detrack — an honest privacy / telemetry-reduction tool

A small, dependency-free CLI that **audits** a machine for tracking and
telemetry, and **generates reviewable, reversible scripts** to reduce the parts
that are actually reducible in software.

It is deliberately honest about the parts that are *not* removable by any
program — because pretending otherwise would be selling snake oil.

## The honest picture

| Thing | Software-removable? | What detrack does |
|-------|--------------------|-------------------|
| Windows telemetry (DiagTrack, CEIP, telemetry endpoints) | **Yes, reversibly** | Generates PowerShell to disable the service/tasks, set the telemetry policy, and blackhole telemetry hosts — with a full undo script. |
| MAC address | **Yes, reversibly** | Generates a NetworkManager drop-in that randomizes it. |
| Intel Management Engine (ME/AMT) | **No** | Explains why: it's firmware on a chipset co-processor. Neutralizing it needs an SPI reflash (`me_cleaner`/coreboot) with hardware access and can brick the board. No OS-level app can do it. |
| "CPU serial number" | **N/A** | Doesn't exist on modern CPUs. The Pentium III PSN (1999) was off by default and dropped from later chips. |
| TPM / hardware attestation | **No** | A security chip. Can be turned off in BIOS but not "removed" by software; disabling it breaks BitLocker / Windows 11. |

If you have seen an app advertised as a one-click "remove the trackers Intel
builds into your CPU," it is misinformed or dishonest. The levers that genuinely
exist are the ones in the table above, and this tool operates exactly those.

## Usage

```bash
python3 detrack.py audit            # read-only scan; changes nothing
python3 detrack.py hardware-report  # the honest explainer, standalone
python3 detrack.py plan --out ./detrack-out
```

`plan` writes scripts to `./detrack-out/` for **you to read and run**. It never
touches your system itself:

```
detrack-out/
├── windows/
│   ├── apply.ps1          # elevated PowerShell: conservative telemetry reduction
│   ├── undo.ps1           # reverses apply.ps1
│   └── hosts-block.txt    # the telemetry hostnames it blackholes
├── linux/
│   ├── apply.sh           # root: MAC randomization via NetworkManager
│   └── undo.sh            # reverses apply.sh
└── REPORT.md              # what changes, and how to undo each one
```

## Safety model

- **Read-only by default.** `audit` and `hardware-report` never write anything.
- **Review before run.** `plan` only *generates* scripts; you execute them.
- **Reversible.** Every generated change ships with an undo script. The Windows
  hosts file is backed up (`hosts.detrack.bak`) before it is edited.
- **Conservative.** The Windows script does not touch Windows Update, the
  Microsoft Store, Defender, licensing, or time sync — blocking those breaks
  legitimate functionality.

## Requirements

Python 3.9+. No third-party packages. Applying the generated scripts requires
Administrator (Windows) or root (Linux), and NetworkManager for MAC
randomization on Linux.

## Legitimate use

This is defensive privacy tooling for **your own devices**. It reduces
diagnostic-data collection and network-level fingerprinting. It is not, and
cannot be, a way to defeat firmware- or silicon-level features.
