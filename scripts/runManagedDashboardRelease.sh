#!/usr/bin/env bash
set -euo pipefail

entrypoint="${1:-}"
if (( $# != 1 )); then
    echo "Managed Dashboard runtime requires exactly one entrypoint" >&2
    exit 64
fi
case "$entrypoint" in
    dist/serverStart.js | dist/workerStart.js) ;;
    *)
        echo "Managed Dashboard runtime received an invalid entrypoint" >&2
        exit 64
        ;;
esac

project_root="${MIRA_DASHBOARD_PROJECT_ROOT:-}"
case "$project_root" in
    /*) ;;
    *)
        echo "Managed Dashboard project root must be absolute" >&2
        exit 78
        ;;
esac
if [[ "$project_root" == "/" ]]; then
    echo "Managed Dashboard project root must not be root" >&2
    exit 78
fi
canonical_project_root="$(
    /usr/bin/realpath --canonicalize-existing "$project_root"
)" || {
    echo "Managed Dashboard project root is unavailable" >&2
    exit 78
}
if [[ "$canonical_project_root" != "$project_root" ]]; then
    echo "Managed Dashboard project root must be canonical" >&2
    exit 78
fi

releases_root="$project_root/production/releases"
release_backend="$(/usr/bin/pwd -P)"
release_root="${release_backend%/backend}"
release_commit="${release_root##*/}"
if [[
    "$release_backend" != "$release_root/backend" ||
    "${release_root%/*}" != "$releases_root" ||
    ! "$release_commit" =~ ^[0-9a-f]{40}$
]]; then
    echo "Managed Dashboard working directory is not an immutable release" >&2
    exit 78
fi
manifest_path="$release_root/release-manifest.json"
bun_version="$(
    /usr/bin/jq --exit-status --raw-output \
        '.bunVersion
         | select(type == "string" and length > 0 and length <= 64)
         | select(test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|([0-9]*[A-Za-z-][0-9A-Za-z-]*))(\\.((0|[1-9][0-9]*)|([0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"))' \
        "$manifest_path"
)" || {
    echo "Managed Dashboard release manifest has no valid Bun runtime" >&2
    exit 78
}

runtime_path="$project_root/production/runtimes/bun/$bun_version/bun"
if [[ ! -f "$runtime_path" || ! -x "$runtime_path" || -L "$runtime_path" ]]; then
    echo "Managed Dashboard Bun runtime $bun_version is unavailable" >&2
    exit 78
fi
if [[ "$(/usr/bin/realpath --canonicalize-existing "$runtime_path")" != "$runtime_path" ]]; then
    echo "Managed Dashboard Bun runtime path is not canonical" >&2
    exit 78
fi
if [[ "$(/usr/bin/stat --format='%h' -- "$runtime_path")" != "1" ]]; then
    echo "Managed Dashboard Bun runtime must not have external hard links" >&2
    exit 78
fi
runtime_revision="$("$runtime_path" --revision)"
runtime_version="$("$runtime_path" --version)"
if [[ "$runtime_revision" != "$bun_version" && "$runtime_version" != "$bun_version" ]]; then
    echo "Managed Dashboard Bun runtime version does not match the release" >&2
    exit 78
fi
if [[ "$(/usr/bin/realpath --canonicalize-existing "$releases_root/current")" != "$release_root" ]]; then
    echo "Managed Dashboard working release is no longer active" >&2
    exit 78
fi

exec "$runtime_path" "$entrypoint"
