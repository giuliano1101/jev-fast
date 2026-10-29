# Jev P0 mock benchmark

Samples: 240; success: 240/240; UNKNOWN actions: 0.

These are deterministic engineering baselines. No real Jev/API or main-agent LLM was invoked. Zero mock cost is not a hosted estimate.

| Mode / stratum | n | success | p50 ms | p95 ms | fallback | action errors |
|---|---:|---:|---:|---:|---:|---:|
| scripted | 120 | 120 | 392.94 | 540.62 | 0 | 0 |
| scripted/zh | 60 | 60 | 376.66 | 529.55 | 0 | 0 |
| scripted/en | 60 | 60 | 392.94 | 546.20 | 0 | 0 |
| scripted/form | 10 | 10 | 525.63 | 822.75 | 0 | 0 |
| scripted/filter | 10 | 10 | 297.16 | 311.89 | 0 | 0 |
| scripted/detail | 10 | 10 | 349.98 | 412.32 | 0 | 0 |
| scripted/back | 10 | 10 | 411.64 | 440.69 | 0 | 0 |
| scripted/cancel | 10 | 10 | 324.09 | 345.56 | 0 | 0 |
| scripted/correction | 10 | 10 | 472.04 | 490.75 | 0 | 0 |
| scripted/duplicate | 10 | 10 | 529.55 | 557.55 | 0 | 0 |
| scripted/async | 10 | 10 | 412.01 | 430.49 | 0 | 0 |
| scripted/scroll | 10 | 10 | 340.09 | 371.16 | 0 | 0 |
| scripted/select | 10 | 10 | 298.08 | 312.13 | 0 | 0 |
| scripted/wait | 10 | 10 | 403.62 | 424.74 | 0 | 0 |
| scripted/navigation | 10 | 10 | 358.74 | 376.66 | 0 | 0 |
| mock | 120 | 120 | 380.79 | 544.07 | 0 | 0 |
| mock/zh | 60 | 60 | 380.79 | 542.41 | 0 | 0 |
| mock/en | 60 | 60 | 380.19 | 544.07 | 0 | 0 |
| mock/form | 10 | 10 | 531.05 | 556.82 | 0 | 0 |
| mock/filter | 10 | 10 | 296.07 | 308.47 | 0 | 0 |
| mock/detail | 10 | 10 | 340.99 | 376.42 | 0 | 0 |
| mock/back | 10 | 10 | 413.94 | 440.86 | 0 | 0 |
| mock/cancel | 10 | 10 | 327.32 | 349.49 | 0 | 0 |
| mock/correction | 10 | 10 | 469.81 | 510.26 | 0 | 0 |
| mock/duplicate | 10 | 10 | 521.67 | 548.77 | 0 | 0 |
| mock/async | 10 | 10 | 392.29 | 404.25 | 0 | 0 |
| mock/scroll | 10 | 10 | 335.16 | 369.00 | 0 | 0 |
| mock/select | 10 | 10 | 298.89 | 318.60 | 0 | 0 |
| mock/wait | 10 | 10 | 411.93 | 442.22 | 0 | 0 |
| mock/navigation | 10 | 10 | 355.41 | 390.15 | 0 | 0 |

All started tasks remain in the denominator. Percentiles use nearest rank; cost per success is null if no success. Timing starts before opening the task context, includes initialization, all decisions/actions/waits/verification, and ends at oracle check; context cleanup excluded. Fault cases are tested separately, never mixed into normal success rates. Phase observe includes browser candidate construction; phase candidate measures core candidate validation.

Failures: []

Recompute with `npm run bench:mock`. Raw rows and event phases are attached; summary.json contains all formula results.
