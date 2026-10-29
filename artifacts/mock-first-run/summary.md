# Jev P0 mock benchmark

Samples: 240; success: 234/240; UNKNOWN actions: 6.

These are deterministic engineering baselines. No real Jev/API or main-agent LLM was invoked. Zero mock cost is not a hosted estimate.

| Mode / stratum | n | success | p50 ms | p95 ms | fallback | action errors |
|---|---:|---:|---:|---:|---:|---:|
| scripted | 120 | 116 | 416.46 | 601.15 | 4 | 0 |
| scripted/zh | 60 | 60 | 417.02 | 610.07 | 0 | 0 |
| scripted/en | 60 | 56 | 393.70 | 578.99 | 4 | 0 |
| scripted/form | 10 | 10 | 554.40 | 1058.34 | 0 | 0 |
| scripted/filter | 10 | 10 | 313.39 | 324.32 | 0 | 0 |
| scripted/detail | 10 | 10 | 375.26 | 485.20 | 0 | 0 |
| scripted/back | 10 | 10 | 463.89 | 517.04 | 0 | 0 |
| scripted/cancel | 10 | 10 | 347.12 | 381.03 | 0 | 0 |
| scripted/correction | 10 | 10 | 513.55 | 626.85 | 0 | 0 |
| scripted/duplicate | 10 | 10 | 568.60 | 889.70 | 0 | 0 |
| scripted/async | 10 | 7 | 423.09 | 470.23 | 3 | 0 |
| scripted/scroll | 10 | 10 | 350.75 | 371.52 | 0 | 0 |
| scripted/select | 10 | 10 | 334.71 | 486.15 | 0 | 0 |
| scripted/wait | 10 | 9 | 425.10 | 601.15 | 1 | 0 |
| scripted/navigation | 10 | 10 | 386.92 | 417.42 | 0 | 0 |
| mock | 120 | 118 | 420.50 | 587.03 | 2 | 0 |
| mock/zh | 60 | 60 | 424.10 | 609.67 | 0 | 0 |
| mock/en | 60 | 58 | 390.35 | 581.92 | 2 | 0 |
| mock/form | 10 | 10 | 564.82 | 740.69 | 0 | 0 |
| mock/filter | 10 | 10 | 319.54 | 333.09 | 0 | 0 |
| mock/detail | 10 | 10 | 377.96 | 481.79 | 0 | 0 |
| mock/back | 10 | 10 | 443.35 | 480.56 | 0 | 0 |
| mock/cancel | 10 | 10 | 345.86 | 355.36 | 0 | 0 |
| mock/correction | 10 | 10 | 512.57 | 567.57 | 0 | 0 |
| mock/duplicate | 10 | 10 | 570.30 | 661.08 | 0 | 0 |
| mock/async | 10 | 8 | 425.68 | 516.42 | 2 | 0 |
| mock/scroll | 10 | 10 | 365.31 | 385.25 | 0 | 0 |
| mock/select | 10 | 10 | 331.79 | 438.00 | 0 | 0 |
| mock/wait | 10 | 10 | 438.23 | 498.41 | 0 | 0 |
| mock/navigation | 10 | 10 | 372.76 | 390.04 | 0 | 0 |

All started tasks remain in the denominator. Percentiles use nearest rank; cost per success is null if no success. Timing starts before opening the task context, includes initialization, all decisions/actions/waits/verification, and ends at oracle check; context cleanup excluded. Fault cases are tested separately, never mixed into normal success rates. Phase observe includes browser candidate construction; phase candidate measures core candidate validation.

Failures: [{"id":"async-en-2-scripted","reason":"STALE_SNAPSHOT"},{"id":"async-en-3-scripted","reason":"STALE_SNAPSHOT"},{"id":"async-en-3-mock","reason":"STALE_SNAPSHOT"},{"id":"async-en-4-mock","reason":"STALE_SNAPSHOT"},{"id":"async-en-4-scripted","reason":"STALE_SNAPSHOT"},{"id":"wait-en-4-scripted","reason":"STALE_SNAPSHOT"}]

Recompute with `npm run bench:mock`. Raw rows and event phases are attached; summary.json contains all formula results.
