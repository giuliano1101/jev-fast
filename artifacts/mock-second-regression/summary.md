# Jev P0 mock benchmark

Samples: 240; success: 239/240; UNKNOWN actions: 0.

These are deterministic engineering baselines. No real Jev/API or main-agent LLM was invoked. Zero mock cost is not a hosted estimate.

| Mode / stratum | n | success | p50 ms | p95 ms | fallback | action errors |
|---|---:|---:|---:|---:|---:|---:|
| scripted | 120 | 120 | 383.30 | 554.88 | 0 | 0 |
| scripted/zh | 60 | 60 | 379.01 | 540.28 | 0 | 0 |
| scripted/en | 60 | 60 | 383.30 | 570.20 | 0 | 0 |
| scripted/form | 10 | 10 | 537.76 | 864.62 | 0 | 0 |
| scripted/filter | 10 | 10 | 305.05 | 314.85 | 0 | 0 |
| scripted/detail | 10 | 10 | 357.00 | 376.42 | 0 | 0 |
| scripted/back | 10 | 10 | 429.17 | 444.87 | 0 | 0 |
| scripted/cancel | 10 | 10 | 336.65 | 351.68 | 0 | 0 |
| scripted/correction | 10 | 10 | 496.00 | 506.05 | 0 | 0 |
| scripted/duplicate | 10 | 10 | 542.26 | 576.17 | 0 | 0 |
| scripted/async | 10 | 10 | 397.71 | 417.13 | 0 | 0 |
| scripted/scroll | 10 | 10 | 338.35 | 386.93 | 0 | 0 |
| scripted/select | 10 | 10 | 303.54 | 314.31 | 0 | 0 |
| scripted/wait | 10 | 10 | 408.68 | 444.19 | 0 | 0 |
| scripted/navigation | 10 | 10 | 355.07 | 383.30 | 0 | 0 |
| mock | 120 | 119 | 378.18 | 567.43 | 1 | 0 |
| mock/zh | 60 | 59 | 373.35 | 555.51 | 1 | 0 |
| mock/en | 60 | 60 | 391.36 | 567.89 | 0 | 0 |
| mock/form | 10 | 10 | 547.04 | 584.99 | 0 | 0 |
| mock/filter | 10 | 10 | 304.78 | 324.10 | 0 | 0 |
| mock/detail | 10 | 10 | 353.81 | 395.41 | 0 | 0 |
| mock/back | 10 | 10 | 434.59 | 480.72 | 0 | 0 |
| mock/cancel | 10 | 10 | 337.77 | 353.25 | 0 | 0 |
| mock/correction | 10 | 10 | 486.04 | 536.38 | 0 | 0 |
| mock/duplicate | 10 | 10 | 533.58 | 576.51 | 0 | 0 |
| mock/async | 10 | 9 | 401.37 | 413.33 | 1 | 0 |
| mock/scroll | 10 | 10 | 329.82 | 373.35 | 0 | 0 |
| mock/select | 10 | 10 | 299.57 | 318.01 | 0 | 0 |
| mock/wait | 10 | 10 | 408.36 | 433.86 | 0 | 0 |
| mock/navigation | 10 | 10 | 352.19 | 376.82 | 0 | 0 |

All started tasks remain in the denominator. Percentiles use nearest rank; cost per success is null if no success. Timing starts before opening the task context, includes initialization, all decisions/actions/waits/verification, and ends at oracle check; context cleanup excluded. Fault cases are tested separately, never mixed into normal success rates. Phase observe includes browser candidate construction; phase candidate measures core candidate validation.

Failures: [{"id":"async-zh-3-mock","reason":"STALE_SNAPSHOT"}]

Recompute with `npm run bench:mock`. Raw rows and event phases are attached; summary.json contains all formula results.
