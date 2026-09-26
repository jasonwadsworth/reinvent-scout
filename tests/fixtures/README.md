# Catalog test fixtures

## `catalog-sample.json`

60 sessions carved from a real `ListSessions` pull of the `reinvent2026` catalog taken on
**2026-09-25** (2,043 sessions across 9 pages of 250). The full pull is not committed; it lives
only in the scratchpad used to build this fixture. The carving script is a throwaway (also not
committed — it needs the real pull, which CI does not have) and is not required to reproduce the
fixture; this file is the durable record.

Selection criteria, each verified against the selection before it was written to disk:

- At least one session of each of the ten session types (`Breakout session`, `Builders' session`,
  `Chalk talk`, `Code talk`, `Gamified learning`, `Lightning talk`, `Workshop`, `Bootcamp`,
  `Exam prep`, `Lab`).
- At least 4 sessions each with `venue` set to `MGM Grand`, `Caesars Forum`, and `Venetian`.
- At least 4 sessions each where `venue` is absent and `room` starts with `Wynn/Encore` or
  `Caesars Palace` — the two venues the index has to derive from the room prefix.
- At least 3 sessions with neither `room` nor `sessionTime` (47 such sessions exist in the real
  pull; the fixture carries a handful of them).
- The one session in the entire catalog with no `level` field.
- At least one session with empty (or absent) `services` and `speakers` but a non-empty
  `industries` array — `industries` is present on only 198 of 2,043 sessions and is never
  populated alongside `services`/`speakers` in the small sample checked, so this combination is
  worth exercising deliberately.
- At least one session on each of the five conference dates (`2026-11-30` through `2026-12-04`).
- At least one session with `Amazon DynamoDB` in `services`, and at least one with
  `Elastic Load Balancing (ELB)` — the exact display names the real pull uses, confirmed against
  the snapshot rather than assumed.
- The remainder of the 60 are sessions with both `services` and `speakers` populated, to keep the
  fixture representative of a typical session rather than skewed toward edge cases.

The fixture was re-carved on **2026-09-26** from the same 2026-09-25 snapshot to add the DynamoDB
and ELB coverage above, by swapping in two real sessions carrying those services in place of two
otherwise-redundant `Breakout session` / `Caesars Forum` entries (that venue and session type had
comfortable headroom above every threshold in the list before the swap, so removing two did not
threaten any other criterion). The re-carve was done with a throwaway script run in the scratchpad
against the full pull (not committed, per the note above); this file is still the durable record.

### Speaker-name substitution

Every `speakers[].name` in this file has been replaced with a synthetic name drawn from 20 first
names crossed with 20 surnames spanning a range of naming traditions (e.g. Suzuki, Kowalski,
Okonkwo, Rahman, Silva, Larsen, Petrov, Mensah), assigned by shuffling the full 400-combination
list with a fixed seed and taking one combination per speaker slot — 56 slots across the fixture,
so no two speakers in the file share a name and the fixture does not skew toward any one surname
or origin. Speaker names are the only person-data present in the catalog pull. Every other field —
including `title` and `abstract`, which are the primary text signal for the matcher — is public
catalog copy and is kept verbatim, so text scoring in the test suite runs against realistic input
rather than lorem-ipsum placeholders.

### Field shape

The file is a plain JSON array matching the `items` array of a `ListSessionsResponseContent`
(see `docs/api/openapi.json`), so a test helper can slice it into pages to exercise pagination.
The real pull's sessions only ever populated this subset of the `Session` schema's fields:
`sessionId`, `title`, `abbreviation`, `abstract`, `type`, `level`, `venue`, `room`,
`isAllDaySession`, `isReservable`, `sessionTime`, `services`, `topics`, `areasOfInterest`,
`roles`, `industries`, `speakers`, `features`. Fields the schema allows but this event never sent
(`tracks`, `segments`, `customerPersonas`, `experiences`, `additionalActivities`, `focusAreas`,
`seatAvailability`) are absent here too — the index builder must tolerate their absence
regardless, since the schema documents them as legitimate for other events.
