# Session Mount Runtime

> This document is the runtime contract for **issue #879, "Refactor: standardise
> terminal-process mounting"**. It describes not how one screen behaves but the
> single set of rules governing the relationship between **sessions** and
> **processes** across the whole TUI.
> The screen lives in `src/screens/SessionSupervisor.tsx`; the occupancy
> protocol lives in `src/sessionMounts.ts`.

## 1. Two concepts, separated first

| Concept | Meaning |
| --- | --- |
| **Session** | One running agent conversation; on disk it is an append-only event log |
| **Process** | One TUI terminal process |

The three front ends differ in essence, and that difference is where every
design decision below starts:

- **webui**: a background service process hosts sessions. Close that service
  window and every session stops at once. One machine runs **one** of them.
- **gui**: the whole application hosts sessions. Close the app (or kill its
  tray background) and every session stops at once. One machine runs **one**.
- **tui**: the TUI **is** the terminal process. Close it and the sessions it
  hosts stop. One machine can run **several** TUIs at the same time.

That last row is the source of all the complexity here: a TUI is both a process
and a container that can host several sessions, and **several such containers
can coexist on one machine**. Everything webui and gui avoid by being globally
unique, a TUI has to solve directly.

## 2. The one model: a terminal hosts several sessions

One TUI process = one terminal + one **mount set**: the session currently
attached, plus every **parked** session. Parking is not pausing and not
"save and close" — a parked session **is still alive and still running inside
this process** (an in-flight turn keeps generating); the terminal is simply not
showing its transcript right now.

Three rules follow:

1. **Switching a session changes what you look at, not what is running.**
   Leaving a session parks it; it stays in the mount set and stays visible and
   switchable on the session screen.
2. **A running turn is not a reason to refuse a switch.** The user is choosing
   what to look at, not asking the model to stop. The turn keeps running in the
   background and its row keeps reporting progress.
3. **Exiting the terminal process clears the mount set.** That is what a TUI
   is; there is no process supervisor and no pretence that a session outlives
   its terminal (gui's tray-style background is not TUI semantics). The session
   logs are durable, so `/resume` brings them back next time.

### 2.1 Why there used to be two models

`/resume` was **tui-style**: switching **stopped the current session
immediately** (`keepCurrent=false`, the old handle was `dispose`d), and it
refused outright while a turn was running. `/agentview` was
**gui/webui-style**: switching left the current session running, parked on this
process's background-handle ledger; only exiting the process stopped them.

Neither was a wrong design. They were a historical accident of two commands
growing separately, which is why they kept needing patches against each other on
one shared `resumeTo`, and why users had to learn two mental models. The model
that survived is the overview's, because it is the only one consistent with what
a TUI terminal actually is, and because the channel layer already had the
capability (`backgroundHandles` + the agent-view projection).

`/resume`, `/home`, `/agentview`, `/bg` and the 🏠 button left of the composer
now all land on one screen and one set of actions. They are entries kept for
muscle memory, not four features.

## 3. The cross-process occupancy protocol

### 3.1 The problem

Two TUI processes can each `/resume` the same session id. The DSH session store
has no idea *who is currently driving a log*, so the two processes interleave
writes into **one append-only event log** and corrupt the transcript. That is
not a UX problem; it is data loss.

### 3.2 Who owns what: `~/.dsh-tui/session-mounts.json`

Every TUI process publishes one record naming the sessions it currently has
mounted:

```json
{
  "version": 1,
  "owners": [
    { "pid": 12345, "heartbeatAt": 1789361335705, "startedAt": 1789361300000,
      "sessionIds": ["<sessionId>", "..."] }
  ]
}
```

Write discipline (the pattern already proven in `src/sessionPins.ts`):

- **Cross-process lock**: `session-mounts.lock` (`wx` exclusive create; one
  stale lock may be reclaimed after 30s).
- **Atomic replace**: `session-mounts.json.<pid>.<ts>.<seq>.tmp` + `rename`, so
  a reader never observes a half-written document.
- **Permissions**: directory `0700`, file `0600`.
- **Total and best-effort**: any failure degrades to "no cross-process
  protection this beat". It never throws and never takes a session down.

### 3.3 Liveness needs two witnesses

A record's claim is released only when **both** witnesses agree the owner is
gone:

- **`process.kill(pid, 0)`**: a clean exit, a `kill -9`, or a forcefully closed
  terminal removes the pid. It cannot see **pid reuse**, nor a process on
  another machine sharing the home directory over a network.
- **The `heartbeatAt` timestamp**: no refresh within `HEARTBEAT_TTL_MS` (45s)
  means abandoned. It catches pid reuse (a recycled pid would have to also be
  refreshing this exact record) and a pulled plug.

So:

| Situation | Outcome |
| --- | --- |
| Clean exit (including `Ctrl+C`) | The teardown funnel calls `clearOwnMounts()`; the record is deleted and the sessions are mountable by another tui **immediately** |
| `kill -9` / terminal force-closed | The heartbeat stops, so the claim expires within one TTL (≤45s); the pid probe usually decides sooner |
| Power loss / unplug / suspend | The process is gone and the on-disk record expires — self-healing |
| Owner alive but wedged (blocked event loop) | The claim **stands** (the safe direction: refusing one mount is recoverable, interleaving a log is not) |
| Pid reused | The stale heartbeat still expires, so nothing is locked forever |

**Self-healing needs no reaper**: the read path (`readLiveMounts`) rewrites the
file in place when it finds a dead record. Any screen poll cleans up as a side
effect, so orphaned records need no separate scheduled task.

### 3.4 Check-then-claim is ordered

Mounting a session with no live agent in this process must go:

1. read the ledger (`readSessionOwners`) to find out whether another process
   holds it;
2. if free, publish **our own** claim (`publishMounts`) immediately;
3. only then `await` the resume workflow.

Step 2 precedes step 3 to close the race where two TUIs both pass step 1: the
first to publish wins and the second is refused at step 1. Publishing is a
lock-guarded read-modify-write, so concurrent publishes cannot lose each other.

**A session with a live agent in this process skips the occupancy check**: it is
already mounted here, there is no second claimant to race, and it goes straight
through live adoption (the same path that parks the session being left). It must
**never** be resumed from disk a second time, which would mount one log twice.

### 3.5 The screen contract

- A session held by **another** tui: **still listed**, but the row turns red,
  the state cell shows `⊘`, and the row ends with `held by pid <pid>`; entering
  reports `Another TUI terminal holds this session (pid <pid>); cannot enter`.
- A session held by **this** process (parked) is not "occupied": it must be
  switchable back from this screen.
- A free session that is not live here: enterable as normal.

## 4. Refresh cost

Occupancy and live status are two in-memory/small-file reads, deliberately
separate from "re-list the sessions" (one `stat` per session plus a
revision-keyed digest cache):

| Data | Source | Cadence |
| --- | --- | --- |
| Mount-set heartbeat (write) | `publishMounts`, one small lock-guarded file write | `HEARTBEAT_INTERVAL_MS` = **15s** |
| On-screen live status / occupancy (read) | The channel's agent-view projection snapshot + the ledger | The screen's own **2s** tick, `setState` only |
| Session listing | `listSessions()` | Once when the screen opens, plus manual `Ctrl+L` |

All three follow the repository's existing resource discipline:

- Every timer is `.unref()`d; it must never be the reason a process cannot exit.
- Every timer is cleaned up through `ctx.effect` / the `owner.own` funnel.
- `readLiveMounts` heals on the read path, adding no reaper timer.

There is no memory growth: the ledger is bounded by (processes × ≤256 session
ids each) and is rewritten wholesale on each publish; live status reads the
projection snapshot the channel already maintains rather than creating a new
subscription.

## 5. Relationship to dpx isolated environments

TUIs created by dpx are **fully isolated** from each other, and isolated runtime
state is written under **each environment's own home path**:

- The session ledger path is `join(homedir(), '.dsh-tui')`
  (`src/utils/paths.ts`), and a dpx isolation rewrites `HOME` / `USERPROFILE`,
  so each environment's `.dsh-tui` naturally lands inside its own environment
  root and **cannot** see another environment's mount records.
- The session-log root is `$DSH_HOME/sessions`, again per-environment.

Consequently: **multiple TUIs in the same environment see and protect each
other; different environments do not interfere at all** — which is exactly what
"an isolated environment's TUI is not disturbed by another's runtime" means in
practice. Cross-environment collisions on a session id cannot arise, because
even the session store root differs.

## 6. Invariants (keep these when changing this area)

1. **One log is driven by one process at a time.** The occupancy check must
   happen before any `await` that could start growing the log, and the claim
   must be published immediately after the check.
2. **Switching a session never destroys it.** Park, do not `dispose`; a running
   turn is not interrupted by a switch.
3. **A claim must never be locked forever.** Every record must be reclaimable by
   either "pid gone" or "heartbeat expired". A state that requires manual
   unlocking is forbidden.
4. **The read path must not throw.** Missing file, corrupt JSON, wrong version,
   wrong field types — all read as empty, and the next write repairs it.
5. **A timer must never block exit.** `.unref()` plus funnel cleanup, both.
6. **The screen must not disagree with the runtime.** Whether a session can be
   entered is the runtime's decision; the screen only explains the reason one
   step earlier. Both paths share one set of words via
   `src/sessions/resumeFailure.ts`.
