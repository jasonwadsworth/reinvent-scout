# Watching a full session

A playbook for reserving a session that is full, the moment a seat opens. There is no watcher
program. You run the loop yourself, one check at a time, with the MCP tools: `get_schedule`,
`get_session`, `reserve_sessions` and `cancel_reservation`. Everything below is your judgment to
apply, not code to call.

## Starting a watch

1. Confirm the target sessions with the user: title, day, time and venue of each.
2. Ask for the exact list of reservations you may cancel to make room. It can be empty, and
   empty is the safe default. Call it the **may-cancel list**.
3. Ask whether there is an end time, such as when the user stops caring or the session starts.
4. The user's answer is their consent to reserve the targets and to cancel only the reservations
   on that list. Never cancel anything that is not on the may-cancel list, and never add to it
   yourself. If you think another reservation should go, ask, and wait for a clear yes.
5. If the may-cancel list is not empty, tell the user that a swap briefly frees their seat, and
   that a restore refused as full means it is lost.

This is the one exception to the general rules that you never cancel conflicts automatically and
that a later retry needs an explicit new request: inside a watch the user confirmed, the may-cancel
list is the explicit choice of cancellations and the running watch is the standing request for
re-attempts. Outside a watch, these rules hold.

## State you carry between checks

Nothing is saved for you. Keep this in your own working notes and update it after every check:

- the targets (id, title, day and time)
- the exact may-cancel list
- the last seat band you saw for each target
- which targets have a deferred swap, and at which band
- the last thing you told the user about each target
- the backoff level
- the end time
- pending restores (ids and attempt count)

**If you lose track** (a new session, a compacted context, or memory you no longer trust):
check the transcript or ask the user about in-flight swaps and pending restores before doing
anything else. Then re-read `get_schedule` and re-confirm the targets with the user before anything
else that writes: reserving without re-confirmation is not allowed. Also re-confirm the may-cancel list
with the user, and do not cancel anything until the user re-confirms. Retrying a pending restore
of a reservation this watch cancelled is exempt from re-confirmation.

## Driving the loop

Use the client's own scheduling, such as `/loop` (self-paced) or a cron or wakeup in Claude
Code. Check about every 3 minutes, and never more often than every 1 minute. Add jitter so
checks do not land on a round minute. After a 429 or another transient error, double the wait,
up to 30 minutes, and reset after a clean check. Stop scheduling when every target is resolved,
when the end time passes, or on anything that needs the user. Never stop the wakeups of a pending
restore this way: restore wakeups keep running even after the rest of the watch stops.

## One check

1. Call `get_schedule`.
   - A target that is already reserved (the user may have done it by hand) is resolved.
   - A reservation on the may-cancel list that is no longer reserved: drop it from the list.
2. For each target still pending, call `get_session` and note its `seatAvailability` band and
   `isReservable`. Do the targets one after another, not in parallel.
3. If `isReservable` is false, or the band is `walkUp`, stop that target and tell the user.
4. If the band is anything other than `unavailable`, including a missing band, call
   `reserve_sessions` for that one target. The API decides whether a seat exists; the band is
   only a hint.
5. Read the result for the target:
   - `sessionFull`: keep watching.
   - `alreadyScheduled`: done.
   - `scheduleConflict`: see the next section.
   - `timePassed`, `sessionNotReservable`, `insufficientAccess` or `walkUp`: stop that target and
     tell the user.
   - An unknown code: stop that target and tell the user.
6. A `get_session` 404 in the middle of a watch is transient. The 2026-10 outage 404'd real
   session ids, so it is not proof the session is gone. Back off and keep watching.
7. Auth required, not registered, or a 409 (reservations closed): stop the whole watch and tell
   the user. A 429 or a service error is transient: back off.

## Conflicts and swaps

`scheduleConflict` names the reservations it clashes with in `conflictsWith`.

- `reserve_sessions` may omit some of the clashes it lists and says how many in
  `omittedConflicts`. If `omittedConflicts` is not 0, read the full set from `get_schedule` and
  apply the every-id rule to it before swapping.
- Swap only if every id in `conflictsWith` is on the may-cancel list. There are no partial
  swaps: if even one id is not on the list, do not swap. Cancel exactly those ids and no others,
  even if the list has more.
- Otherwise do not cancel. Tell the user once what it clashes with, and keep watching. Say it
  again only if the set of clashes changes.

To swap:

0. Before each swap, tell the user in the conversation which ids are about to be cancelled, so
   the transcript is the durable record.
1. Cancel one reservation at a time and read each result. `cancel_reservation` reports `outcome`
   and `verifiedAbsent`: `outcome` is `cancelled`, `alreadyAbsent` or `uncertain`.
   - A cancel that says the reservation was already gone (404) is not something to restore
     (`alreadyAbsent`). A cancel with outcome `alreadyAbsent` is never re-reserved, even when the
     read-back fails: it was gone before this watch touched it.
   - A cancel is uncertain if `outcome` is `uncertain`, if `get_schedule` afterwards cannot be
     read, or if it still lists the reservation: an acknowledged cancel (`outcome` is `cancelled`)
     whose `verifiedAbsent` is not true counts as uncertain. Then stop cancelling, do not reserve
     the target, re-reserve anything you already cancelled, and re-reserve the uncertain one
     too. Restore every cancel that was confirmed. If it is still held, that returns
     `alreadyScheduled`, which is harmless; if it was cancelled, the re-reserve restores it. The
     target is never reserved on this path, so nothing can double-book. In every uncertain-cancel
     case, stop the watch and tell the user.
   - If a cancel is refused with a 429, re-reserve the ones you already cancelled and skip the
     target for this check, and back off.
   - If a cancel is refused because auth is required, you are not registered, or reservations are
     closed (409), re-reserve the ones you already cancelled, then stop the whole watch and tell
     the user. A 400 (validation error) or an OAuth failure on a cancel is treated like auth:
     re-reserve what you cancelled, then stop the whole watch.
2. Reserve the target with `reserve_sessions`.
3. Decide what the result means.
   - If the target reserve was refused (any failure code), or the read-back shows it absent,
     restore: re-reserve what you cancelled.
   - If the target reserve is uncertain and the read-back cannot be done, restore anyway. If the
     target did land, the API refuses the restore with `scheduleConflict`, so it cannot
     double-book (the target overlaps the cancelled reservation by definition); if it did not land,
     the restore saves the user's seat. Then verify with `get_schedule` when you can, stop the whole
     watch, and tell the user exactly what is known.
   - If it landed, the cancelled reservations are gone: remove them from the may-cancel list.
4. Restore only what you actually cancelled. Retry a restore only when it was refused by a 429 or
   never sent, up to 3 times, about 1 minute apart. A restore refused with `sessionFull` is lost;
   do not retry it. A retry cannot wait inside one turn: record the ids and the attempt count under
   pending restores and schedule a short wakeup (about 1 minute) for the retry. Remember that a
   pending restore is not lost until its retries run out or it is refused with `sessionFull`.
   Every re-reserve-then-stop branch that gets a 429 becomes a pending restore: restore wakeups
   keep running even after the rest of the watch stops, and you tell the user right away that a
   restore is pending. A pending restore takes priority over everything else on the next check.
   While a restore is pending, never attempt another swap.
5. Verify with `get_schedule`. Report exactly what was kept, gained and lost. If anything was
   lost or is uncertain, stop the whole watch and tell the user right away. A schedule that
   changed in a way the user did not approve must not be changed further.

After a swap you undid (the target was full again), do not try it again until that target's seat
band changes. Each attempt briefly frees the user's existing seat, and someone else could take
it. Record the band at that moment as the deferred swap; going to `unavailable` and back counts
as a change. Meanwhile, report the conflict once and wait for the seat band to change.

## Uncertain writes

Never blindly replay a write. If a reserve or cancel gives no clear answer, let the next
`get_schedule` decide whether it landed. A reserve acknowledged as successful but missing from the
`get_schedule` read-back is uncertain, not reserved.

## Using judgment

This is why an agent runs the loop.

- If a target stays full, look in the catalog for a repeat of the same talk (a code ending
  `-R` or `-R1`) and offer it to the user. Do not reserve a repeat without asking.
- If a target's time or venue changed, tell the user.
- If the user's other reservations changed in a way that affects the watch, say so.

## Talking to the user

Stay quiet on checks where nothing changed. Notify the user (a push notification where the client
has one) when a session is reserved, a swap happened, a target was stopped, anything was lost or
is uncertain, or the watch ended.

## Limits

Run one watch per account at a time, with up to about 10 targets. Travel time between venues is
not checked: say so when a reservation lands next to another venue's session.
