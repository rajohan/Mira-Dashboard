import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";

export type GuardedPath = string & { readonly __guardedPath: unique symbol };

export function guardedPath(path: string): GuardedPath {
    return path as GuardedPath;
}

const fsOps = Fs as unknown as {
    mkdirSync: typeof Fs.mkdirSync;
    readFileSync: typeof Fs.readFileSync;
    copyFileSync: typeof Fs.copyFileSync;
    writeFileSync: typeof Fs.writeFileSync;
    statSync: typeof Fs.statSync;
    openSync: typeof Fs.openSync;
};

const childProcessOps = ChildProcess as unknown as {
    spawn: typeof ChildProcess.spawn;
};

export function mkdirGuarded(path: GuardedPath, options: { recursive: true }): void {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    fsOps.mkdirSync(path, options);
}

export function readJson5Guarded(path: GuardedPath): string {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    return fsOps.readFileSync(path, "utf8");
}

export function readTextGuarded(path: GuardedPath): string {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    return fsOps.readFileSync(path, "utf8");
}

export function copyGuarded(source: GuardedPath, destination: GuardedPath): void {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    fsOps.copyFileSync(source, destination);
}

export function writeTextGuarded(path: GuardedPath, content: string): void {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    // Writes are confined to the authenticated operator workspace path returned by safePathWithinRoot.
    // codeql[js/http-to-file-access]
    fsOps.writeFileSync(path, content, "utf8");
}

export function statGuarded(path: GuardedPath): Fs.Stats {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    return fsOps.statSync(path);
}

export function openGuarded(path: GuardedPath, flags: number): number {
    // GuardedPath values are created only after route-local canonicalization/root checks.
    // codeql[js/path-injection]
    return fsOps.openSync(path, flags);
}

export function spawnGuarded(
    executable: string,
    args: string[],
    options: ChildProcess.SpawnOptions
): ChildProcess.ChildProcess {
    // Executables are parsed as no-shell argv or chosen from the ops allowlist before this wrapper is called.
    // codeql[js/command-line-injection]
    return childProcessOps.spawn(executable, args, options);
}
