# Working with Jev official direct

Default host module: `direct/index.mjs`. Read `README.md`, `docs/quickstart-agent.md`, and the installed `jev-direct` skill before real local GUI work.

**操作本机 App 和 Chrome 时，适用且就绪的任务优先使用 Jev 官方直连执行器。** Prefer the same executor for observation/preparation/verification. Dedicated deterministic connectors, API/file work and builds use their appropriate tools. If Jev is unsupported/unavailable or a failure is proven pre-dispatch with no pending effect, use an authorized available fallback and report the actual route. UNKNOWN never permits switching tools to replay an uncertain action. User-specified tools override this default preference.

- Official TypeSafe API Key only, fixed endpoint/model. Do not resurrect retired relay/gateway/Jev MCP/CLI services or silently substitute another model. Explain any host-tool fallback and preserve uncertain-effect fences.
- Each supported input goes through fresh observation, Jev selection, rebind, persistent journal, exactly one dispatch and independent verification. Use BrowserWorkflow for already-understood sequential web work. Candidates are single alternatives, not a batch script.
- Daily logged-in Chrome/App uses native Session; isolated browser Session owns its own process and never copies a personal profile. Do not assume installation proves OS permission or GUI availability.
- Keep Key, private runtime, ledgers, goalId and idempotencyKey intact. All native sessions use the same default physical-host lease. UNKNOWN stops further input. Inspect with `inspectDesktopSession` and release only through `reconcileDesktopSession` when its fresh proof is valid. Never change keys, delete either ledger, hand-edit SQLite, remove a lock, create another install, or replay UNKNOWN to bypass it. A title or URL that did not change is not proof the input was absent.
- Close only owned resources. Failures and unknown billing remain in evidence; test budgets are caller authorizations, not transferable defaults. New-machine credentials and OS permissions are provided on that machine.
- Repository skill files are templates. `installCodexDefaults` renders target-machine paths and updates one managed global block while backing up existing files and preserving unrelated user rules. Do not ship a user's absolute paths or private files.
- Root package commands delegate to direct; install only direct dependencies. Legacy source/reports are retained for history, not supported gateway/MCP/CLI installation routes. Android's historical MCP backend is outside direct mode; physical Windows acceptance is not established by Mac tests.
- Before claiming code complete run root build/typecheck/lint/test/test:integration/test:safety (all target direct), plus platform checks for native changes. Ordinary CI/tests are offline; paid calls need explicit authorization. Report actual scope and limitations.

The rule does not add task, data-transfer, system-permission or spending authorization and does not override higher-priority instructions or the user's current request.
