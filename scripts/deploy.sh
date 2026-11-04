#!/usr/bin/env bash
set -euo pipefail
umask 077

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$task_root"
mkdir -p .deploy
chmod 700 .deploy

# The Node deploy command redacts credentials before writing its output.
if node scripts/deploy.mjs "$@" 2>&1 | tee .deploy/deploy.log; then
  exit 0
else
  deploy_status=${PIPESTATUS[0]}
  node scripts/diagnose-deploy.mjs || true
  exit "$deploy_status"
fi
