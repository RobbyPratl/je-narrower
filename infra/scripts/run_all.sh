#!/usr/bin/env bash
# Rebuild the whole demo dataset from a freshly-created ERPNext site.
#
#   ./infra/scripts/run_all.sh
#
# Assumes the frappe_docker stack is up (compose project "erpnext") and the site
# "frontend" exists with the erpnext app installed. Every step is idempotent, so
# re-running is safe; pass --reset to wipe posted transactions and re-drive.
#
# Total runtime on a laptop: ~5 minutes, dominated by the setup wizard.

set -euo pipefail

CONTAINER=erpnext-backend-1
SITE=frontend
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
EXPORTS="$REPO/data/exports"

run() {  # run <module> <function> [args...]
  # No `|| true` here: with `set -o pipefail` a python traceback must abort the
  # run. Letting a failed stage continue would cascade into a plausible-looking
  # but wrong export with exit code 0, which is the worst outcome for a dataset
  # whose whole point is being trustworthy.
  docker exec "$CONTAINER" bash -c \
    "cd /home/frappe/frappe-bench/sites && ../env/bin/python /tmp/jerun.py $*" \
    2>&1 | grep -v RuntimeWarning
}

echo "==> staging scripts into $CONTAINER"
docker exec "$CONTAINER" mkdir -p /tmp/jescripts /tmp/exports
for f in setup_site.py seed_master.py drive.py timestamps.py export.py; do
  docker cp "$HERE/$f" "$CONTAINER:/tmp/jescripts/$f"
done

# The runner: import a module from /tmp/jescripts and call one of its functions,
# so failures produce a real traceback instead of bench-console line noise.
docker exec "$CONTAINER" bash -c 'cat > /tmp/jerun.py <<"PYEOF"
import sys, frappe
frappe.init(site="'"$SITE"'")
frappe.connect()
sys.path.insert(0, "/tmp/jescripts")
mod = __import__(sys.argv[1])
try:
    getattr(mod, sys.argv[2])(*sys.argv[3:])
finally:
    frappe.destroy()
PYEOF'

echo "==> 1/5 setup wizard (installs ERPNext fixtures + main company + FY2025)"
run setup_site main

echo "==> 2/5 master data"
run seed_master main

if [[ "${1:-}" == "--reset" ]]; then
  echo "==> wiping posted transactions"
  run drive reset_transactions
fi

echo "==> 3/5 driving P1 (2025-01..06)"
run drive run P1
echo "==> 3/5 driving P2 (2025-07..12)"
run drive run P2

echo "==> 4/5 timestamp synthesis"
run timestamps main

echo "==> 5/5 exports + sanity checks"
run export main

echo "==> copying exports to $EXPORTS"
mkdir -p "$EXPORTS"
docker cp "$CONTAINER:/tmp/exports/." "$EXPORTS/"
ls -la "$EXPORTS"
echo "done."
