/**
 * Wraps one direct development child in a Linux parent-death and PPID guard.
 * @param command Absolute executable plus arguments for the long-lived child.
 * @param parentProcessId Expected coordinator process id.
 * @returns A command that cannot outlive a crashed or killed coordinator.
 */
export function guardedDevelopmentChildCommand(
    command: readonly string[],
    parentProcessId = process.pid
): readonly string[] {
    if (command.length === 0 || !command[0]?.startsWith("/")) {
        throw new TypeError("Development child command must use an absolute executable");
    }
    if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 1) {
        throw new TypeError("Development child command parent PID is invalid");
    }
    const setpriv = Bun.which("setpriv");
    const shell = Bun.which("sh");
    if (setpriv === null || shell === null) {
        throw new Error(
            "Dashboard development requires setpriv and sh for child cleanup"
        );
    }
    return [
        setpriv,
        "--pdeathsig",
        "SIGKILL",
        shell,
        "-c",
        '[ "$PPID" = "$1" ] || exit 125\nshift\nexec "$@"',
        "dashboard-development-child",
        String(parentProcessId),
        ...command,
    ];
}

/**
 * Wraps one root command in a dedicated process group owned by a non-setuid supervisor.
 * The supervisor stays parent-bound after sudo clears its own parent-death signal, while
 * the inner ancestry and PPID checks close both fork-to-prctl race windows.
 * @param command Absolute privileged executable plus arguments.
 * @param parentProcessId Expected coordinator process id.
 * @returns A sudo command with a post-fork parent-death and PPID guard.
 */
export function guardedDevelopmentPrivilegedCommand(
    command: readonly string[],
    parentProcessId = process.pid
): readonly string[] {
    if (command.length === 0 || !command[0]?.startsWith("/")) {
        throw new TypeError(
            "Privileged development command must use an absolute executable"
        );
    }
    if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 1) {
        throw new TypeError("Privileged development command parent PID is invalid");
    }
    const setpriv = Bun.which("setpriv");
    const setsid = Bun.which("setsid");
    const shell = Bun.which("sh");
    const sudo = Bun.which("sudo");
    if (setpriv === null || setsid === null || shell === null || sudo === null) {
        throw new Error(
            "Dashboard development requires sudo, setpriv, setsid, and sh for privileged child cleanup"
        );
    }
    const innerGuard = '[ "$PPID" = "$1" ] || exit 125\nshift\nexec "$@"';
    const sudoGuard = [
        "expected_parent=$1",
        "setpriv=$2",
        "shell=$3",
        "inner_guard=$4",
        "inner_name=$5",
        "shift 5",
        "sudo_monitor=$PPID",
        "monitor_parent=",
        'while IFS=":" read -r field value; do',
        '    if [ "$field" = "PPid" ]; then',
        "        monitor_parent=$value",
        "        break",
        "    fi",
        'done < "/proc/$sudo_monitor/status" || exit 125',
        '[ "$monitor_parent" -eq "$expected_parent" ] 2>/dev/null || exit 125',
        'exec "$setpriv" --pdeathsig SIGKILL "$shell" -c "$inner_guard" "$inner_name" "$sudo_monitor" "$@"',
    ].join("\n");
    const supervisorGuard = [
        "expected_parent=$1",
        "sudo=$2",
        "shell=$3",
        "sudo_guard=$4",
        "setpriv=$5",
        "inner_guard=$6",
        "shift 6",
        '[ "$PPID" = "$expected_parent" ] || exit 125',
        "terminate() {",
        "    trap '' TERM INT HUP",
        '    kill -TERM "-$$" 2>/dev/null || true',
        "    sleep 1",
        '    kill -KILL "-$$" 2>/dev/null || true',
        "    exit 143",
        "}",
        "trap terminate TERM INT HUP",
        '"$sudo" -n "$shell" -c "$sudo_guard" dashboard-development-sudo "$$" "$setpriv" "$shell" "$inner_guard" dashboard-development-privileged-child "$@" &',
        "privileged_pid=$!",
        '[ "$PPID" = "$expected_parent" ] || terminate',
        'wait "$privileged_pid"',
        "status=$?",
        "trap - TERM INT HUP",
        'exit "$status"',
    ].join("\n");
    return [
        setsid,
        setpriv,
        "--pdeathsig",
        "SIGTERM",
        shell,
        "-c",
        supervisorGuard,
        "dashboard-development-privileged-supervisor",
        String(parentProcessId),
        sudo,
        shell,
        sudoGuard,
        setpriv,
        innerGuard,
        ...command,
    ];
}
