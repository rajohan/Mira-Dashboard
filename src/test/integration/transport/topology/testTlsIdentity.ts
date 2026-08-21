import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tlsIdentityFailurePrefix = "Could not generate integration TLS identity";

/** Ephemeral certificate material trusted only by one integration scenario. */
export interface TestTlsIdentity {
    certificate: string;
    dispose(): Promise<void>;
    privateKey: string;
}

/**
 * Generates a localhost certificate with OpenSSL `req` and `-addext` support.
 * @returns Ephemeral certificate material and a deterministic cleanup callback.
 */
export async function createTestTlsIdentity(): Promise<TestTlsIdentity> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-dashboard-tls-"));
    const certificatePath = path.join(directory, "certificate.pem");
    const privateKeyPath = path.join(directory, "private-key.pem");
    let preserveDirectory = false;

    try {
        const opensslExecutable = Bun.which("openssl");
        if (opensslExecutable === null) {
            throw new Error(
                `${tlsIdentityFailurePrefix}: OpenSSL with req and -addext support is required; executable not found`
            );
        }
        const openssl = Bun.spawn(
            [
                opensslExecutable,
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
        const [exitCode, stderr, stdout] = await Promise.all([
            openssl.exited,
            new Response(openssl.stderr).text(),
            new Response(openssl.stdout).text(),
        ]);

        if (exitCode !== 0) {
            const diagnostic = stderr.trim() || stdout.trim() || "no diagnostic output";
            throw new Error(
                `${tlsIdentityFailurePrefix}: OpenSSL req with -addext support is required (exit ${exitCode}): ${diagnostic}`
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
    } catch (error) {
        if (
            error instanceof Error &&
            error.message.startsWith(tlsIdentityFailurePrefix)
        ) {
            throw error;
        }
        throw new Error(
            `${tlsIdentityFailurePrefix}: OpenSSL with req and -addext support is required`,
            { cause: error }
        );
    } finally {
        if (!preserveDirectory) {
            await rm(directory, { force: true, recursive: true });
        }
    }
}
