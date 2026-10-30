"""Summarize one immutable S10-C run. Never sends requests or edits raw results."""
import argparse
import json
import math
from collections import Counter
from pathlib import Path


def percentiles(values):
    values = sorted(values)
    if not values:
        return {"n": 0, "p50_ms": None, "p95_ms": None}
    return {"n": len(values), "p50_ms": values[math.ceil(.5 * len(values)) - 1],
            "p95_ms": values[math.ceil(.95 * len(values)) - 1]}


def analyze(root):
    summary = json.loads((root / "summary.json").read_text())
    rows = json.loads((root / "rows.json").read_text())
    attempts = json.loads((root / "attempts.json").read_text())
    warmup = json.loads((root / "warmup.json").read_text())
    assert len(rows) == 9 and summary["formal_success_denominator"] == 9
    executed = [r for r in rows if r["status"] != "NOT_RUN"]
    success = [r for r in rows if r["status"] == "SUCCEEDED"]
    budget_delta = summary["budget_after"]["requests"] - summary["budget_before"]["requests"]
    assert budget_delta >= len(attempts)
    assert summary["budget_after"]["requests"] <= 30
    assert summary["budget_after"]["reserved_usd"] <= .1
    assert summary["mode"] == "live" and summary["enforcement_mode"] == "required_jev"
    actions = [a for r in [warmup] + executed for a in r.get("actions", [])]
    applied = [a for a in actions if a["status"] in ["EXECUTING", "VERIFYING", "SUCCEEDED", "FAILED", "UNKNOWN"]]
    verified = [a for a in applied if a.get("route") == "jev"]
    idempotency = [r["idempotency"] for r in [warmup] + executed if "idempotency" in r]
    idempotency_passed = sum(i["same_result"] and i["before_requests"] == i["after_requests"]
                             and i["before_decisions"] == i["after_decisions"] for i in idempotency)
    stats = {}
    for label, subset in [("all_executed", executed), ("successful", success)]:
        stats[label] = {field: percentiles([r[field] for r in subset if field in r])
                        for field in ["e2e_ms", "e2e_excluding_duplicate_ms", "run_goal_ms"]}
    provider = percentiles([a["observed_ms"] for a in attempts if "observed_ms" in a])
    usage = [a["usage"] for a in attempts if a.get("usage") is not None]
    data = {
        "quantile_method": "nearest rank: sorted[ceil(p*n)-1]; n=9 p95 is sample maximum",
        "formal_planned": 9, "formal_executed": len(executed), "formal_succeeded": len(success),
        "formal_not_run": len(rows) - len(executed), "success_fraction_of_planned": len(success) / 9,
        "status_counts": dict(Counter(r["status"] for r in rows)),
        "by_task": {task: {"planned": 3, "executed": sum(r["task"] == task for r in executed),
                            "succeeded": sum(r["task"] == task for r in success)}
                    for task in ["cancel", "correction", "form"]},
        "latency": stats, "hosted_observed_latency": provider,
        "hosted_attempts": len(attempts), "http_status_counts": dict(Counter(str(a.get("http_status", "unknown")) for a in attempts)),
        "reservation_delta": budget_delta, "reserved_usd": summary["budget_after"]["reserved_usd"],
        "usage_known_requests": len(usage), "usage_unknown_attempts": len(attempts) - len(usage),
        "reservations_without_observed_transport": budget_delta - len(attempts),
        "known_input_tokens": sum(u["input_tokens"] for u in usage),
        "known_output_tokens": sum(u["output_tokens"] for u in usage),
        "estimated_known_cost_usd": sum(u["input_tokens"] for u in usage) * .042 / 1e6,
        "price_source": "https://docs.typesafe.ai/models",
        "actions_entered_execution": len(applied), "actions_with_jev_route": len(verified),
        "idempotency_checks": len(idempotency), "idempotency_passed": idempotency_passed,
        "offline_stop": summary["offline_stop"], "credentials_revoked": summary["credentials_revoked"],
        "temporary_credentials_removed": summary["temporary_credentials_removed"],
        "local_service_stopped": summary["local_service_stopped"],
        "stop_reason": summary["stop_reason"],
    }
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = analyze(args.run_dir)
    with args.out.open("x") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
