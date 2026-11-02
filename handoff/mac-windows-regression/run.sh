#!/bin/bash
# Run only inside a disposable clone, never in the running service checkout.
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then
    printf '%s\n' 'This regression runner requires macOS.' >&2
    exit 2
fi
JEV_MAC_SOURCE="$(cd "$(dirname "$0")/../.." && pwd -P)"
export JEV_MAC_SOURCE
python3 - <<'PY'
import os,pathlib,subprocess
p=pathlib.Path(os.environ['JEV_MAC_SOURCE']).resolve()
assert p.name=='repo' and p.parent.name.startswith('jev-windows-mac.') and p.parent.parent==pathlib.Path('/tmp').resolve(), 'Use the disposable clone command in README.md.'
assert subprocess.check_output(['git','-C',str(p),'branch','--show-current'],text=True).strip()=='handoff/mac-windows-regression-20261102', 'Wrong test branch'
assert not subprocess.check_output(['git','-C',str(p),'status','--porcelain','--untracked-files=no'],text=True).strip(), 'Tracked source changed before regression'
PY
cd "$JEV_MAC_SOURCE"
mkdir -p .runtime/mac-regression
if [ -f .runtime/mac-regression/status.tsv ]; then
    printf '%s\n' 'A report already exists; create a new disposable clone for a rerun.' >&2
    exit 2
fi
trap 'JEV_MAC_EXIT=$?; trap - EXIT; python3 handoff/mac-windows-regression/report.py "$JEV_MAC_EXIT"' EXIT
run_check() {
    JEV_CHECK_GROUP="$1"
    JEV_CHECK_NAME="$2"
    shift 2
    set +e
    "$@" >".runtime/mac-regression/$JEV_CHECK_NAME.log" 2>&1
    JEV_CHECK_EXIT=$?
    set -e
    printf '%s\t%s\t%s\n' "$JEV_CHECK_GROUP" "$JEV_CHECK_NAME" "$JEV_CHECK_EXIT" >>.runtime/mac-regression/status.tsv
    printf '%s exit code: %s\n' "$JEV_CHECK_NAME" "$JEV_CHECK_EXIT"
    return "$JEV_CHECK_EXIT"
}
# This helper only adds the original Mac's Node directory and local npm wrappers.
if [ -f scripts/env.sh ]; then . scripts/env.sh; fi
run_check setup node_version node -e 'const v=process.versions.node.split(".").map(Number);if(v[0]<24||(v[0]===24&&v[1]<19))process.exit(1);console.log(process.version)'
run_check setup npm_ci npm ci --ignore-scripts --cache "$JEV_MAC_SOURCE/../npm-cache" --no-audit --no-fund
export PLAYWRIGHT_SKIP_BROWSER_GC=1
run_check setup chromium npx playwright install chromium
run_check setup desktop_build npm run desktop:build
run_check setup artifact_parser python3 -m pip install --no-deps --require-hashes --only-binary=:all: --target .runtime/python-packages -r scripts/requirements-windows.txt
JEV_MAC_FAILED=0
run_check check typecheck npm run typecheck || JEV_MAC_FAILED=1
run_check check lint npm run lint || JEV_MAC_FAILED=1
run_check check unit npm test || JEV_MAC_FAILED=1
run_check check integration npm run test:integration || JEV_MAC_FAILED=1
run_check check safety npm run test:safety || JEV_MAC_FAILED=1
run_check check deployment python3 -m unittest discover -s deploy/network/tests -v || JEV_MAC_FAILED=1
run_check check native_protocol python3 -m unittest discover -s tests/native -p test_macos_driver.py -v || JEV_MAC_FAILED=1
exit "$JEV_MAC_FAILED"
