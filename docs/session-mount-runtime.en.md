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
    { "pid": 12345, "startedAt": 1789361300000,
      "sessionIds": ["<sessionId>", "..."] }
  ]
}
```

The source of truth for ownership is **pid**: while that process exists, the
record still counts as live. `host` / `instance` are deliberately not part of
the record — a home directory can be shared over a network, but genuinely
deciding across machines needs a transport-level protocol, not a field written
to a local disk. Pid reuse only makes a session that is in fact free look
occupied (one restart fixes it); the opposite error interleaves two writers
into one log.

Write discipline (the pattern already proven in `src/sessionPins.ts`):

- **Cross-process lock**: `session-mounts.lock` (`wx` exclusive create; one
  stale lock may be reclaimed after 30s). The lock file holds the RANDOM TOKEN
  of the acquisition, not a pid.
- **Atomic replace**: `session-mounts.json.<pid>.<ts>.<seq>.tmp` + `rename`, so
  a reader never observes a half-written document.
- **A reclaimed holder must not write**: a writer that exceeded
  `STALE_LOCK_MS` and had its lock taken has to notice that the lock is no
  longer its own, abandon the commit, and — on the way out — delete only its OWN
  lock rather than the new holder's.
- **Permissions**: directory `0700`, file `0600`.
- **Total and best-effort**: any failure degrades to "no cross-process
  protection this beat". It never throws and never takes a session down.

### 3.3 Liveness has exactly one witness: the pid

A record is live if and only if `process.kill(pid, 0)` holds (`EPERM` counts as
alive too). There is **no heartbeat timestamp**: a timestamp is only trustworthy
while a timer keeps refreshing it, and the process that cannot refresh it is
exactly the record that should expire. One witness gives one answer instead of
two that can contradict each other.

| Situation | Outcome |
| --- | --- |
| Clean exit (including `Ctrl+C`) | The teardown funnel calls `clearOwnMounts()`; the record is deleted and the sessions are mountable by another tui **immediately** |
| `kill -9` / terminal force-closed / power loss | The pid is gone, so the next read ignores the record |
| Pid reused | The record reads as occupied until that unrelated process exits |

The known cost is stated in the module header: this ledger is a **same-machine**
visibility layer, not the write authority — the host's own session write lock is
what separates writers.

**The read path never writes back.** Reads only filter; cleanup happens on the
write path. Filtering a lock-free snapshot and writing it back drops any record
a peer published in between — `rename` atomicity prevents half a file, not a
lost update — so "self-healing on read" would degrade into "deleting a peer's
claim on read".

### 3.4 Check and claim are one step

Mounting a session with no live agent in this process must go:

1. read the ledger (`readSessionOwners`) as a **pre-filter**, only so the user
   can be told which pid holds the session;
2. if free, call `claimMount(sessionId)`: inside the cross-process lock it
   re-reads the file, re-derives the conflict, writes **nothing** on a conflict,
   and on success splices its own fresh record into the current file;
3. only then `await` the resume workflow.

"Check, then publish" is **not atomic across processes**: two processes can each
observe `free` at step 1 and then publish in turn, leaving two live holders of
one session in the ledger. Step 2 is what makes the admission decision real.

A claim this call newly took is released (`releaseMount`) when the switch is
vetoed, the binding went stale, or the resume threw — a reservation must never
outlive the attempt that made it.

**A session that already has a live agent in this process neither checks
occupancy nor goes through live adoption**: it is the session currently
attached, so entering it again is an idempotent success that keeps the same
Agent handle. That short-circuit is load-bearing — handing `undefined` to the
adoption transaction takes its default `dispose` path, which STOPS the running
session and still reports success.

### 3.5 The screen contract

- A session held by **another** tui: **still listed**, but the row turns red,
  the state cell shows `⊘`, and the row ends with `held by pid <pid>`; entering
  reports `Another TUI terminal holds this session (pid <pid>); cannot enter`.
- A session held by **this** process (parked) is not "occupied": it must be
  switchable back from this screen.
- A free session that is not live here: enterable as normal.
- Occupancy is re-read from the ledger on the screen's own **2s** tick; the host
  must not capture a snapshot into a callback at render time, or a peer that
  exited leaves the row red and unclickable until some unrelated channel event
  happens to repaint.
- The **registry is not the whole store**: it can legitimately be empty (a bare
  composition mounts no workspace service, or a registration was removed while
  its logs stayed on disk). The screen must fall back to a group derived from
  the sessions' own `cwd`, so those sessions stay visible and resumable — "no
  registration" is not "no history".

## 4. Refresh cost

Occupancy and live status are two in-memory/small-file reads, deliberately
separate from "re-list the sessions" (one `stat` per session plus a
revision-keyed digest cache):

| Data | Source | Cadence |
| --- | --- | --- |
| Mount-set publish (write) | `publishMounts`, one small lock-guarded file write | `PUBLISH_INTERVAL_MS` = **15s** |
| On-screen live status / occupancy (read) | The channel's agent-view projection snapshot + the ledger | The screen's own **2s** tick, `setState` only |
| Session listing | `listSessions()` | Once when the screen opens, plus manual `Ctrl+L` |

All three follow the repository's existing resource discipline:

- Every timer is `.unref()`d; it must never be the reason a process cannot exit.
- Every timer is cleaned up through `ctx.effect` / the `owner.own` funnel.
- The read path never touches the file: dead records are filtered in memory and
  actually pruned by the next write.

There is no memory growth: the ledger holds (processes × their mounted session
ids) and is rewritten wholesale on each publish; live status reads the
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

1. **One log is driven by one process at a time.** The admission decision must
   be made inside the cross-process lock (`claimMount`: re-read + conflict
   re-check + claim write in one step), never as a lock-free "check, then
   publish". Re-entering a session this process already hosts must short-circuit
   idempotently and must never take a path that disposes the handle.
2. **Switching a session never destroys it.** Park, do not `dispose`; a running
   turn is not interrupted by a switch.
3. **A claim must never be locked forever.** Every record must be reclaimable by
   "pid gone". A state that requires manual unlocking is forbidden.
4. **Same-machine semantics must stay explicit.** Ownership is pid-only; do not
   use a local `host` / `instance` field to pretend the ledger decides across
   machines — two machines sharing a home directory need a transport-level
   protocol, not this layer.
5. **Only the holder writes or releases the lock.** Each acquisition writes a
   random token into the lock file; a holder that lost the lock (reclaimed as
   stale) must abandon its commit, and a release may delete only its own lock.
6. **The read path must not throw, and must not write back.** Missing file,
   corrupt JSON, wrong version, wrong field types — all read as empty, and the
   next write repairs it; cleanup must re-read under the lock rather than
   committing a pre-lock snapshot.
7. **A timer must never block exit.** `.unref()` plus funnel cleanup, both.
8. **The screen must not disagree with the runtime.** Whether a session can be
   entered is the runtime's decision; the screen only explains the reason one
   step earlier. Both paths share one set of words via
   `src/sessions/resumeFailure.ts`.
9. **The screen must not assume the registry is complete.** Sessions in an empty
   registry or an unregistered directory stay visible and resumable, a FAILING
   registry read must not discard the session listing that already succeeded,
   and occupancy is re-read every tick instead of reusing a host render snapshot.
10. **The focus is one fact.** The session list's cursor is keyed by **sessionId**
    and every index is derived from it, so render, movement and Enter agree.
