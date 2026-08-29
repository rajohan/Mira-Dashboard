import { constants } from "node:fs";
import { chmod, mkdir, open, rename } from "node:fs/promises";

const credentialDirectory = "/home/ubuntu/.config/mira-dashboard/automation";

export interface ProductionDeployCredentialInstallerOptions {
    readonly directory?: string;
    readonly readInput?: () => Promise<string>;
    readonly writeOutput?: (message: string) => void;
}

/**
 * Installs a one-time Dashboard-issued credential without exposing it in argv or output.
 * @param readInput Secure stdin boundary, injectable for focused verification.
 */
export async function installProductionDeployCredential(
    options: ProductionDeployCredentialInstallerOptions = {}
): Promise<void> {
    const directory = options.directory ?? credentialDirectory;
    const credentialPath = `${directory}/delivery-deploy.token`;
    const input = await (
        options.readInput ?? (async () => await new Response(Bun.stdin.stream()).text())
    )();
    const token = input.trim();
    if (!/^[0-9a-f]{32}\.[0-9a-f]{64}$/u.test(token)) {
        throw new Error("Production deploy credential installation failed");
    }
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const temporary = `${credentialPath}.new-${crypto.randomUUID()}`;
    const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
    );
    try {
        await file.writeFile(`${token}\n`, { encoding: "utf8" });
        await file.sync();
    } finally {
        await file.close();
    }
    await rename(temporary, credentialPath);
    (options.writeOutput ?? process.stdout.write.bind(process.stdout))(
        "Installed production deploy credential\n"
    );
}

if (import.meta.main) {
    await installProductionDeployCredential().catch(() => {
        process.stderr.write("Production deploy credential installation failed\n");
        process.exitCode = 1;
    });
}
