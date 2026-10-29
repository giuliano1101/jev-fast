# Jev P0 mock benchmark

Samples: 40; success: 40/40; UNKNOWN actions: 0.

These are deterministic engineering baselines. No real Jev/API or main-agent LLM was invoked. Zero mock cost is not a hosted estimate.

| Mode / stratum | n | success | p50 ms | p95 ms | fallback | action errors |
|---|---:|---:|---:|---:|---:|---:|
| scripted | 20 | 20 | 416.05 | 436.85 | 0 | 0 |
| scripted/zh | 10 | 10 | 410.32 | 421.82 | 0 | 0 |
| scripted/en | 10 | 10 | 422.13 | 1339.69 | 0 | 0 |
| scripted/async | 10 | 10 | 413.24 | 1339.69 | 0 | 0 |
| scripted/wait | 10 | 10 | 419.68 | 430.51 | 0 | 0 |
| mock | 20 | 20 | 413.61 | 427.18 | 0 | 0 |
| mock/zh | 10 | 10 | 412.43 | 429.48 | 0 | 0 |
| mock/en | 10 | 10 | 413.61 | 427.18 | 0 | 0 |
| mock/async | 10 | 10 | 413.61 | 429.48 | 0 | 0 |
| mock/wait | 10 | 10 | 412.43 | 421.00 | 0 | 0 |

All started tasks remain in the denominator. Percentiles use nearest rank; cost per success is null if no success. Timing starts before opening the task context, includes initialization, all decisions/actions/waits/verification, and ends at oracle check; context cleanup excluded. Fault cases are tested separately, never mixed into normal success rates. Phase observe includes browser candidate construction; phase candidate measures core candidate validation.

Failures: []

Recompute with `npm run bench:mock`. Raw rows and event phases are attached; summary.json contains all formula results.
