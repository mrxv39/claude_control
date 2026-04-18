# Claudio Control

**Visual session monitor for Claude Code on Windows Terminal.**

An always-on-top bar that shows all your Claude Code sessions at a glance: which ones are working, which ones are waiting for input, and lets you switch between them with a single click.

![Windows 11](https://img.shields.io/badge/Windows-11-0078D4?logo=windows11)
![Electron](https://img.shields.io/badge/Electron-41-47848F?logo=electron)
![License](https://img.shields.io/badge/license-MIT-green)

---

## The problem

When you run multiple Claude Code sessions in Windows Terminal, every tab shows the same generic title. There's no way to tell which session is actively processing a prompt, which one is waiting for input, and clicking the right tab is a guessing game — especially with 2+ WT windows.

## The solution

A lightweight Electron bar pinned to the top of your screen:

- **One chip per session** — colored by status (green = working, red = waiting/idle)
- **Project name** extracted from each session's working directory
- **Click to focus** — brings the correct WT window to the front (even across multiple WT windows)
- **Ctrl+Click to tile** — select 2+ sessions and they auto-arrange side by side
- **Title overlays** — floating labels pinned to each WT window's title bar showing the project name
- **Draggable** — starts centered at the top; drag it anywhere and it stays put
- **Auto-resize** — bar width adjusts to fit the number of active sessions

### Status colors

| Status   | Color | Meaning                              |
|----------|-------|--------------------------------------|
| BUSY     | Green | Claude is processing a prompt        |
| WAITING  | Red   | Claude session open, waiting for you |
| IDLE     | Red   | Shell with no Claude running         |

---

## Quick start

### Prerequisites

- Windows 10/11
- Windows Terminal
- Node.js 18+
- Claude Code CLI installed

### 1. Clone and install

```powershell
git clone https://github.com/mrxv39/claude_control.git
cd claude_control/electron-monitor
npm install
```

### 2. Configure the Claude Code hook

Add this to your `~/.claude/settings.json` (create it if it doesn't exist):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\path\\to\\claude_control\\electron-monitor\\claude-state-hook.ps1\" -Status BUSY"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\path\\to\\claude_control\\electron-monitor\\claude-state-hook.ps1\" -Status WAITING"
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\path\\to\\claude_control\\electron-monitor\\claude-state-hook.ps1\" -Status WAITING"
      }
    ]
  }
}
```

> Replace `C:\\path\\to\\claude_control` with your actual install path.

### 3. Launch

```powershell
cd electron-monitor
npm start
```

The bar appears centered at the top of your screen. Open a few Claude Code sessions and watch the chips appear.

---

## How it works

### Session detection (`get-sessions.ps1`)

Enumerates all shell processes (`powershell`, `pwsh`, `cmd`) that are children of `WindowsTerminal.exe`. For each shell:

- Reads the **real working directory** from the process PEB via `NtQueryInformationProcess` + `ReadProcessMemory` (no heuristics, no temp files)
- Checks if Claude Code is running as a child process
- Reads the **hook state file** (`~/.claude/claudio-state/<hash>.json`) for accurate status

### Window identification (`claude-state-hook.ps1`)

Windows Terminal can run multiple windows in a single process, so tab indices don't reliably identify windows. The hook solves this:

1. When you submit a prompt (`BUSY` event), the hook captures `GetForegroundWindow()` — at that exact moment, the WT window hosting your session is in the foreground
2. The HWND is persisted in a state file keyed by the session's working directory
3. The monitor reads this HWND and uses `SetForegroundWindow` for precise focus — no keystroke simulation needed

### Title overlays

A frameless, transparent, click-through `BrowserWindow` is created for each WT window. A 100ms polling loop:

- Repositions each overlay centered on its WT window's title bar
- Hides overlays when the WT window is minimized, hidden, or occluded by another window

### Tiling

Ctrl+Click chips to select them. With 2+ selected, windows auto-tile:

- 2 windows: side by side
- 3 windows: three columns
- 4 windows: 2x2 grid
- 5+: auto-calculated grid

---

## Autonomous orchestrator

Beyond the visual monitor, Claudio Control ships two autonomous execution systems that run Claude Code tasks in the background using unused quota from your 5-hour rate-limit cycle.

### Queue-based scheduler (classic)

A panel (⚙ button on the bar) scans your projects folder, scores each one (1-10) and runs skills from a catalog (`audit-claude-md`, `security-review`, `simplify`, `add-tests`, `dep-update`, `git-cleanup`, `ui-polish`, `supabase-audit`, `perf-audit`, `fix-types` + community skills) on branches `claudio/auto/*`. Never touches `master`, never pushes.

- **Smart pacing** — uses a `progress^0.6 × 95%` target curve to maximize token use inside the 5h cycle without burning the limit early. Modes: burst (15s tick) → accelerate → pace → coast (120s).
- **Per-project busy** — runs on projects where you don't have an active Claude session. Doesn't block everything because one session is busy.
- **Priorities** — by last-commit age: high (≤7d), medium (8-30d), low (31-90d), ignored (>90d).

### Goal-driven autonomous system (F1+)

In parallel with the queue scheduler, an `AutonomousOrchestrator` runs in **dry-run mode by default**. For each project marked active in the Autónomo tab, it:

1. Reads the project goal template (`production-ready`, `MVP-lanzable`, `mantenimiento`, `explorar-idea`, `seguro-y-testeado`).
2. Runs an LLM planner that converts `{goal, current state, checks}` into concrete next actions.
3. Registers decisions as events in a JSONL log — and, once you toggle to real execution, runs them with circuit-breaker protection and optional auto-PR via `gh pr create`.

Both systems coexist: the classic scheduler runs on every project in `orchestrator.json`; the F1+ system only on projects you explicitly activate.

---

## Legacy tools (PowerShell)

The repo also includes the original PowerShell-based tools that work without Electron:

- **`claude-session`** / **`cs`** — launches Claude Code with a smart tab title showing the project name
- **`Start-SessionMonitor`** — TUI dashboard showing all terminal sessions in real time

Install with:

```powershell
.\Install.ps1
```

---

## Known limitations

- **HWND capture requires at least one prompt** — sessions that haven't sent a prompt yet fall back to a less reliable focus method
- **Tab drag-out** — if you drag a Claude tab to a new WT window, the cached HWND is stale for up to 5 minutes
- **Single monitor optimized** — multi-monitor setups may have overlay positioning quirks

## Contributing

This is an early-stage project. Feedback, bug reports, and PRs are welcome! Please open an issue to discuss before submitting large changes.

## License

MIT
