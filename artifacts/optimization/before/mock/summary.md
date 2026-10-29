# Jev P0 mock benchmark

Samples: 240; success: 240/240; UNKNOWN actions: 0.

These are deterministic engineering baselines. No real Jev/API or main-agent LLM was invoked. Zero mock cost is not a hosted estimate.

| Mode / stratum | n | success | p50 ms | p95 ms | fallback | action errors |
|---|---:|---:|---:|---:|---:|---:|
| scripted | 120 | 120 | 383.45 | 536.97 | 0 | 0 |
| scripted/zh | 60 | 60 | 367.75 | 535.02 | 0 | 0 |
| scripted/en | 60 | 60 | 390.78 | 536.97 | 0 | 0 |
| scripted/form | 10 | 10 | 532.27 | 839.38 | 0 | 0 |
| scripted/filter | 10 | 10 | 292.41 | 317.82 | 0 | 0 |
| scripted/detail | 10 | 10 | 352.75 | 370.28 | 0 | 0 |
| scripted/back | 10 | 10 | 427.45 | 447.18 | 0 | 0 |
| scripted/cancel | 10 | 10 | 325.99 | 343.71 | 0 | 0 |
| scripted/correction | 10 | 10 | 447.00 | 508.43 | 0 | 0 |
| scripted/duplicate | 10 | 10 | 524.88 | 559.72 | 0 | 0 |
| scripted/async | 10 | 10 | 410.97 | 523.34 | 0 | 0 |
| scripted/scroll | 10 | 10 | 344.93 | 372.86 | 0 | 0 |
| scripted/select | 10 | 10 | 305.40 | 367.75 | 0 | 0 |
| scripted/wait | 10 | 10 | 422.87 | 520.69 | 0 | 0 |
| scripted/navigation | 10 | 10 | 358.15 | 440.82 | 0 | 0 |
| mock | 120 | 120 | 395.53 | 523.31 | 0 | 0 |
| mock/zh | 60 | 60 | 388.35 | 523.78 | 0 | 0 |
| mock/en | 60 | 60 | 395.53 | 523.14 | 0 | 0 |
| mock/form | 10 | 10 | 523.31 | 548.05 | 0 | 0 |
| mock/filter | 10 | 10 | 297.04 | 318.22 | 0 | 0 |
| mock/detail | 10 | 10 | 341.25 | 374.94 | 0 | 0 |
| mock/back | 10 | 10 | 411.36 | 445.68 | 0 | 0 |
| mock/cancel | 10 | 10 | 327.58 | 351.09 | 0 | 0 |
| mock/correction | 10 | 10 | 455.54 | 498.85 | 0 | 0 |
| mock/duplicate | 10 | 10 | 498.49 | 527.38 | 0 | 0 |
| mock/async | 10 | 10 | 401.61 | 501.07 | 0 | 0 |
| mock/scroll | 10 | 10 | 353.24 | 449.57 | 0 | 0 |
| mock/select | 10 | 10 | 309.60 | 369.69 | 0 | 0 |
| mock/wait | 10 | 10 | 415.66 | 469.06 | 0 | 0 |
| mock/navigation | 10 | 10 | 375.11 | 496.97 | 0 | 0 |

All started tasks remain in the denominator. Percentiles use nearest rank; cost per success is null if no success. Timing starts before opening the task context, includes initialization, all decisions/actions/waits/verification, and ends at oracle check; context cleanup excluded. Fault cases are tested separately, never mixed into normal success rates. Phase observe includes browser candidate construction; phase candidate measures core candidate validation.

Failures: []

Recompute with `npm run bench:mock`. Raw rows and event phases are attached; summary.json contains all formula results.
