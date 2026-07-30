#!/usr/bin/env bash
set -euo pipefail

repository_root="$(
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
    pwd -P
)"
dashboard_project_root="${MIRA_DASHBOARD_PROJECT_ROOT:-/home/ubuntu/projects/mira-dashboard}"
expected_checkout="$dashboard_project_root/production/checkout"

if [[ "$(id -u)" == "0" ]]; then
    echo "Run Dashboard bootstrap as the managed system user, not root" >&2
    exit 1
fi
if [[ "$repository_root" != "$expected_checkout" ]]; then
    echo "Dashboard bootstrap checkout must be $expected_checkout" >&2
    exit 1
fi

managed_user="$(id -un)"
linger_state="$(/usr/bin/loginctl show-user "$managed_user" --property=Linger --value 2>/dev/null || true)"
if [[ "$linger_state" != "yes" ]]; then
    echo "Enabling persistent systemd user services for $managed_user"
    /usr/bin/sudo /usr/bin/loginctl enable-linger "$managed_user"
fi
linger_state="$(/usr/bin/loginctl show-user "$managed_user" --property=Linger --value)"
if [[ "$linger_state" != "yes" ]]; then
    echo "systemd linger was not enabled for $managed_user" >&2
    exit 1
fi

bootstrap_bun="${MIRA_DASHBOARD_DEPLOY_BUN_EXECUTABLE:-${HOME}/.bun/bin/bun}"
if [[ ! -f "$bootstrap_bun" || ! -x "$bootstrap_bun" || -L "$bootstrap_bun" ]]; then
    echo "Dashboard bootstrap Bun is unavailable: $bootstrap_bun" >&2
    exit 1
fi

cd "$repository_root"
"$bootstrap_bun" install --frozen-lockfile
exec /usr/bin/env \
    MIRA_DASHBOARD_PROJECT_ROOT="$dashboard_project_root" \
    NODE_ENV=production \
    "$bootstrap_bun" scripts/productionBootstrap.ts
