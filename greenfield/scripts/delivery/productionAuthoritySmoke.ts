import { executeSystemctlProcess, type SystemctlExecutor } from "./systemctlProcess.ts";

const authoritySmokeFailureMessage = "Production authority smoke failed";
const systemctlExecutable = "/usr/bin/systemctl";
const webUnit = "mira-dashboard-web.service";
const workerUnit = "mira-dashboard-worker.service";
const webUnitPath = "/etc/systemd/system/mira-dashboard-web.service";
const workerUnitPath = "/etc/systemd/system/mira-dashboard-worker.service";

function failure(): Error {
    return new Error(authoritySmokeFailureMessage);
}

async function readProperty(
    execute: SystemctlExecutor,
    unit: string,
    property: string
): Promise<string> {
    try {
        const result = await execute(systemctlExecutable, [
            "show",
            `--property=${property}`,
            "--value",
            unit,
        ]);
        if (result.exitCode !== 0 || result.stderr.byteLength !== 0) throw failure();
        return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
    } catch {
        throw failure();
    }
}

/**
 * Proves the live system-manager identity split after the authenticated target smoke.
 * The manifest-verified web unit's three Docker-negative ExecStartPre checks already
 * passed if that exact unit is active; this adds the live principal and fragment proof.
 */
export async function runProductionAuthoritySmoke(
    execute: SystemctlExecutor = executeSystemctlProcess
): Promise<void> {
    const [webUser, workerUser, webFragment, workerFragment, webGroups, workerGroups] =
        await Promise.all([
            readProperty(execute, webUnit, "User"),
            readProperty(execute, workerUnit, "User"),
            readProperty(execute, webUnit, "FragmentPath"),
            readProperty(execute, workerUnit, "FragmentPath"),
            readProperty(execute, webUnit, "SupplementaryGroups"),
            readProperty(execute, workerUnit, "SupplementaryGroups"),
        ]);
    if (
        webUser !== "mira-dashboard-web" ||
        workerUser !== "ubuntu" ||
        webFragment !== webUnitPath ||
        workerFragment !== workerUnitPath ||
        webGroups.length > 0 ||
        workerGroups.split(/\s+/u).filter(Boolean).join(" ") !== "docker"
    ) {
        throw failure();
    }
}
