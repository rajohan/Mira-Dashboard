import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates the smallest reviewed repository layout used by boundary tests.
 * @returns Absolute path to the temporary repository fixture.
 */
export async function temporaryProject(): Promise<string> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-source-boundary-"));
    await mkdir(path.join(projectRoot, "scripts"));
    await mkdir(path.join(projectRoot, "src", "browser"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), "{}");
    return projectRoot;
}
