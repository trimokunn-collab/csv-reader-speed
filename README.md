# csv-reader-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/trimokunn-collab/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/trimokunn-collab/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# Fast CSV reader — csv-reader-speed-01

A faster drop-in for make.fun's csv-reader 1.0.0 for the bounty
"Read broken CSV files faster, 21 November 2026". `main.ts` is the house
driver, unchanged; `solve.js` is the entry: a dependency-free ES module whose
`run(input)` returns exactly the answer csv-reader 1.0.0 returns for every
input `{text, header}` — the same `{columns, rows, errors}`, the same
broken-row policy, error for error.

## Approach

csv-reader 1.0.0 is written to be plain, not fast: it reads one character at
a time and builds every field by concatenating one character at a time. This
reader keeps the same single left-to-right pass and the same semantics, but
never builds a field character by character:

- **Slice, don't concatenate.** Unquoted fields are scanned with `charCodeAt`
  and cut out of the text with a single `slice`. Stray CRs (dropped, with a
  `stray_cr` error) split a field into clean runs; only then are the runs
  joined — the common field is one scan plus one slice.
- **Jump quote to quote.** A quoted field first locates its closing quote
  with `indexOf('"', …)` jumps, stepping over doubled quotes. The scan
  mutates nothing, so the unterminated-quote restart (literal quote, re-read
  as unquoted) costs no re-scan of state.
- **Fast path for clean quoted content.** When the content holds no doubled
  quote and no CR, the value is a single `slice` of the source and only its
  newlines are counted (by scan for short fields, by `indexOf` jumps for long
  ones). Content that does rewrite — `""` to `"`, CRLF or a lone CR to LF —
  is assembled from clean runs between rewrites, joined once.
- **No per-field objects.** Field results pass through one reusable record
  inside `run`, and errors are pushed in the reference's exact shape and
  order.

`run` is pure: no state survives a call.

## Verification

Checked against the reference implementation from the bounty kit:

- All 6 practice cases reproduce `practice/reference/expected.json` exactly,
  and this entry's `answers.json` is byte-identical to the house baseline's.
- A randomized differential fuzzer (nasty mixes of quotes, doubled quotes,
  quote junk, unterminated quotes, stray CRs, CRLFs, empty lines, short/long
  rows, BOM, header on/off) agrees with the reference on all 85,000+
  generated cases.
- Locally the reader runs the full practice set about **8x faster** than
  the reference in process CPU time (the contest ranks CPU time alone):
  ~93 ms vs ~765 ms per pass over the 6 cases on the development machine.
