import { constants } from "node:fs";
import { chmod, mkdir, open, rename } from "node:fs/promises";

const credentialDirectory = "/home/ubuntu/.config/mira-dashboard/automation";
const credentialPath = `${credentialDirectory}/delivery-deploy.token`;

/**
 * Installs a one-time Dashboard-issued credential without exposing it in argv or output.
 * @param readInput Secure stdin boundary, injectable for focused verification.
 */
export async function installProductionDeployCredential(
    readInput: () => Promise<string> = async () =>
        await new Response(Bun.stdin.stream()).text()
): Promise<void> {
    const input = await readInput();
    const token = input.trim();
    if (!/^[0-9a-f]{32}\.[0-9a-f]{64}$/u.test(token)) {
        throw new Error("Production deploy credential installation failed");
    }
    await mkdir(credentialDirectory, { mode: 0o700, recursive: true });
    await chmod(credentialDirectory, 0o700);
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
    process.stdout.write("Installed production deploy credential\n");
}

if (import.meta.main) {
    await installProductionDeployCredential().catch(() => {
        process.stderr.write("Production deploy credential installation failed\n");
        process.exitCode = 1;
    });
}
