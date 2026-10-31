# Real deployment research selector

This adapter asks the actual Jev model to select from a fixed catalog of sanitized deployment controls. It is separate from the formal Engine, which still supports only the twelve synthetic fixture tasks. It does not support arbitrary websites, commands, Chrome operations or remote execution. It never sends raw accessibility trees, screenshots, accounts, source, addresses, domains, credentials or operator configuration in the model body.

Only the constructor receives the private model key. Input contains a finite phase, all fixed boolean checks, fixed boolean host eligibility and catalog candidate IDs. Descriptions and goal are authored in this module. The host must freshly verify each checked fact and each eligibility flag, remove completed actions from candidates, independently authorize the selected action, execute through the already authorized host UI, and verify the actual outcome. A model selection is not action completion or permission to use an operator API.

Preflight may select uploaded-source, DNS and listener checks in any order. Later phases each expose their single catalog action after all earlier checks. `selector_elapsed_ms` measures reservation, Jev request and validation only. `execution_status: "NOT_EXECUTED"` is always returned. This is a narrow research selector; it does not establish execution speed, a computer-use benchmark, public reachability or deployment success.

No CLI, key loader, ledger initialization/reset or built-in approval is provided. The host must supply an explicit **current** approval and a persistent reservation callback backed by the operator's existing private ledger. Approval IDs and expiry are checked locally and are omitted from the request body. Expired/invalid approvals and invalid input never reserve or dispatch. Requests use the existing encoder, fixed model/endpoint, a 15-second deadline (including reservation), a 64 KiB response limit and no retries. The reservation must cover one request with at most $0.01 exposure. A timeout during an unsettled reservation counts conservatively as an unknown attempt; preserve the audit and do not replay. Valid usage is accounted even when an answer is rejected. Reported `known_cost_usd` follows the repository's Jev input-token rate; missing or invalid usage remains unknown.

The following exact input is suitable only when all three preflight controls have independently become eligible. Change the host eligibility booleans and candidate list to match current verified authorization. No approval or ledger is created by this example.

```js
import {
  DeploymentDecisionAdapter,
  decideDeployment,
} from './dist/bench/deployment/decision.js';

const input = {
  phase: 'preflight',
  checked: {
    uploaded_source_verified: false,
    dns_verified: false,
    listeners_inspected: false,
    private_relay_prepared: false,
    private_health_verified: false,
    https_published: false,
    public_mcp_verified: false,
    operator_route_inspected: false,
  },
  host_authorized: {
    verify_uploaded_source: true,
    verify_dns: true,
    inspect_listeners: true,
    prepare_private_relay: false,
    verify_private_health: false,
    publish_https: false,
    verify_public_mcp: false,
    inspect_operator_route: false,
  },
  candidates: ['verify_uploaded_source', 'verify_dns', 'inspect_listeners'],
};

// These three values are provided privately by the operator/authorized host.
// Do not fabricate them or reuse an expired budget. No live call until approved.
const adapter = new DeploymentDecisionAdapter({key: operatorProvidedPrivateKey});
const decision = await decideDeployment(input, adapter, {
  authorization: {
    approval_id: currentOperatorApproval.id,
    expires_at: currentOperatorApproval.expiresAt,
    real_public_controls_only: true,
  },
  reserve: () => existingOperatorApprovedLedger.reserve(),
});
// Recheck the current host UI and authorization before acting on candidate_id.
// Persist only sanitized selector result/accounting; never log the private key.
```

For each subsequent phase, `candidates` and the corresponding eligible flag must contain only the current incomplete catalog action. Earlier prerequisite checks must be true:

| Phase | Catalog action | Required earlier checks |
| --- | --- | --- |
| `preflight` | `verify_uploaded_source`, `verify_dns`, `inspect_listeners` | None; omit each completed check |
| `private_relay` | `prepare_private_relay` | All three preflight checks |
| `private_health` | `verify_private_health` | Preflight and private relay prepared |
| `https` | `publish_https` | All preceding checks including private health |
| `public_mcp` | `verify_public_mcp` | All preceding checks including HTTPS published |
| `operator_route` | `inspect_operator_route` | All preceding checks including public MCP verified |

Errors expose only a fixed `code`, sanitized `accounting` and `selector_elapsed_ms`; provider responses/errors and key values are not attached. The caller is responsible for audit persistence, interpreting low confidence as a stop gate, and avoiding retries after uncertain transport/accounting results. Fake transports in `tests/unit/deployment-decision.test.ts` exercise these boundaries without paid calls.
