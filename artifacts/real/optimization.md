# S7 baseline findings and frozen optimization hypothesis

Baseline collection finished before optimizing. Ordinary computer use: 12/12 working-site tasks succeeded, plus one blocked timeanddate attempt retained separately. Jev baseline: 6/12 succeeded; W2, W3 and D3 each failed twice at the fixed 0.90 confidence gate. Known selection intent was correct at every refused step, but no refused operation was executed. Six successful Jev cases were slower than their matched ordinary runs in this supervised bridge.

Observed bottleneck: W2 exposes both language and query edits as independently valid next steps; W3 consumes one API roundtrip per field and then refuses the inclusive checkbox; D3 offers several independent filter/sort entry points. Each CLI/CUA handoff also incurs outer-agent time. A larger model orchestrates this bridge, so this is not an autonomous tiny-model executor.

Hypothesis: representing a bounded set of independent edits on the same visible form as one candidate, plus explicit current workflow phase, can reduce decision ambiguity and roundtrips without lowering threshold. Implement two local form batches: prepare_search (language + query, no submit) and prepare_dates (date fields + inclusive checkbox, no submit). Only construct a batch if all component controls are currently visible. Revalidate every binding before input and verify all values before allowing the separate submission action. Do not bundle the entire question or arbitrary account actions.

For native filters, retain individual UI actions and all currently visible menu alternatives; provide an explicit order: sort, then audit filter, then genre. Completed conditions come from current controls, never accumulated clicks. Initial observation of empty filter labels while sorting may be transient loading; it is not sufficient evidence of a permanent site bug. Do not automatically replay uncertain inputs.

Remove candidates that make no progress because their current values already match. Record before/after candidate counts and generated batch IDs. Singleton decisions still call real Jev and are reported as constrained choices, not evidence of general model intelligence.

Retest exactly the same six questions twice. This is a within-task engineering retest with learned templates, not held-out generalization. Keep ordinary and baseline data, the anti-bot block, text-verification repair and timing-restoration note. Compare success separately from latency; do not count a quick low-confidence stop as a fast completion.

## Integrated-loop amendment before retest

The optimized retest also removes repeated outer-model/tool handoffs: a bounded CUA loop calls the same Node CLI via a local subprocess, then freshly observes and acts through CUA. The CLI remains responsible for secure key loading and the original durable budget. This changes orchestration as well as candidate policy. Run a separate six-question, one-repeat integrated baseline-policy ablation to make this confound visible. It is supplemental and must not replace the twelve original baseline trials. API latency remains separately recorded; all terminal validation and control operations remain inside measured loop time.

## Results and second repair

Integrated baseline policy: 3/6 completed after a working queue connection, plus two preserved transport failures (3/8 overall). W2/D3 stopped on low confidence; W3 rejected invalid probabilities. First optimized full batch: 5/12, including five low-confidence stops and two checkbox execution uncertainties. No confidence or response validation was relaxed.

Read-only DOM inspection showed Calculator.net's addendday input had a zero-size rectangle while AX exposed its accessible checkbox. Replace DOM setChecked with fresh AX click only for explicitly observed Value:0; Value:1 is left untouched; unknown/ambiguous values reject. Regression tests and review passed. Freeze final-manifest.json and repeat ALL six tasks twice. Final result: 8/12, with W2 and D3 still refusing at the confidence gate. This is a compatibility improvement and bounded workflow optimization, not a general reliability claim.
