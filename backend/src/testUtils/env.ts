export async function withEnv<T>(
    vars: Record<string, string | undefined>,
    callback: () => T | Promise<T>
): Promise<T> {
    const previous = new Map(
        Object.keys(vars).map((key) => [key, process.env[key]] as const)
    );
    try {
        for (const [key, value] of Object.entries(vars)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        return await callback();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}
