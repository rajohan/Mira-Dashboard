import {
    executeSystemctlProcess,
    readSystemctlProperty,
    type SystemctlExecutor,
} from "./systemctlProcess.ts";

const authoritySmokeFailureMessage = "Production authority smoke failed";
const systemctlExecutable = "/usr/bin/systemctl";
const webUnit = "mira-dashboard-web.service";
const workerUnit = "mira-dashboard-worker.service";
const webUnitPath = "/etc/systemd/system/mira-dashboard-web.service";
const workerUnitPath = "/etc/systemd/system/mira-dashboard-worker.service";

function failure(): Error {
    return new Error(authoritySmokeFailureMessage);
}

/**
 * Proves the live system-manager identity split after the authenticated target smoke.
 * The manifest-verified web unit's three Docker-negative ExecStartPre checks already
 * passed if that exact unit is active; this adds the live principal and fragment proof.
 */
export async function runProductionAuthoritySmoke(
    execute: SystemctlExecutor = executeSystemctlProcess
): Promise<void> {
    try {
        const [
            webUser,
            workerUser,
            webFragment,
            workerFragment,
            webGroups,
            workerGroups,
            webDropIns,
            workerDropIns,
        ] = await Promise.all([
            readSystemctlProperty(execute, systemctlExecutable, webUnit, "User"),
            readSystemctlProperty(execute, systemctlExecutable, workerUnit, "User"),
            readSystemctlProperty(execute, systemctlExecutable, webUnit, "FragmentPath"),
            readSystemctlProperty(
                execute,
                systemctlExecutable,
                workerUnit,
                "FragmentPath"
            ),
            readSystemctlProperty(
                execute,
                systemctlExecutable,
                webUnit,
                "SupplementaryGroups"
            ),
            readSystemctlProperty(
                execute,
                systemctlExecutable,
                workerUnit,
                "SupplementaryGroups"
            ),
            readSystemctlProperty(execute, systemctlExecutable, webUnit, "DropInPaths"),
            readSystemctlProperty(
                execute,
                systemctlExecutable,
                workerUnit,
                "DropInPaths"
            ),
        ]);
        if (
            webUser !== "mira-dashboard-web" ||
            workerUser !== "ubuntu" ||
            webFragment !== webUnitPath ||
            workerFragment !== workerUnitPath ||
            webGroups.length > 0 ||
            workerGroups.split(/\s+/u).filter(Boolean).join(" ") !== "docker" ||
            webDropIns.length > 0 ||
            workerDropIns.length > 0
        ) {
            throw failure();
        }
    } catch {
        throw failure();
    }
}
