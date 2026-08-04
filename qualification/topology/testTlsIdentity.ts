import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Ephemeral certificate material trusted only by one qualification test. */
export interface TestTlsIdentity {
    certificate: string;
    dispose(): Promise<void>;
    privateKey: string;
}

/**
 * Generates a localhost certificate for the HTTPS topology probe.
 * @returns Ephemeral certificate material and a deterministic cleanup callback.
 */
export async function createTestTlsIdentity(): Promise<TestTlsIdentity> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-dashboard-tls-"));
    const certificatePath = path.join(directory, "certificate.pem");
    const privateKeyPath = path.join(directory, "private-key.pem");
    let preserveDirectory = false;

    try {
        const openssl = Bun.spawn(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-keyout",
                privateKeyPath,
                "-out",
                certificatePath,
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ],
            { stderr: "pipe", stdout: "pipe" }
        );
        const [exitCode, stderr] = await Promise.all([
            openssl.exited,
            new Response(openssl.stderr).text(),
            new Response(openssl.stdout).text(),
        ]);

        if (exitCode !== 0) {
            const diagnostic = stderr.trim();
            throw new Error(
                `Could not generate qualification TLS identity: ${diagnostic}`
            );
        }
        const [certificate, privateKey] = await Promise.all([
            Bun.file(certificatePath).text(),
            Bun.file(privateKeyPath).text(),
        ]);
        preserveDirectory = true;

        return {
            certificate,
            dispose: () => rm(directory, { force: true, recursive: true }),
            privateKey,
        };
    } finally {
        if (!preserveDirectory) {
            await rm(directory, { force: true, recursive: true });
        }
    }
}
