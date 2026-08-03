import { describe, expect, it, jest } from "bun:test";

import { loadLazyModule } from "../../lib/lazyImportRecovery";
import { preloadModule } from "../../lib/routeModules";

function recoveryStorage(initialValue?: string) {
    let value = initialValue;
    return {
        getItem: jest.fn(() => value),
        removeItem: jest.fn(() => {
            value = undefined;
        }),
        setItem: jest.fn((_key: string, nextValue: string) => {
            value = nextValue;
        }),
    };
}

describe("lazy import recovery", () => {
    it("keeps speculative preload failures silent", () => {
        const importError = new TypeError("Failed to fetch dynamically imported module");
        const load = jest.fn(() => {
            return Promise.try(() => {
                throw importError;
            });
        });

        expect(preloadModule(load)).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("clears the module reload guard after a successful import", () => {
        const storage = recoveryStorage("100");
        const routeModule = { Tasks: () => {} };

        expect(
            loadLazyModule("route-tasks", () => Promise.try(() => routeModule), {
                storage,
            })
        ).resolves.toBe(routeModule);
        expect(storage.removeItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-tasks"
        );
    });

    it("surfaces module evaluation errors without reloading the page", () => {
        const evaluationError = new TypeError(
            "Cannot read properties of undefined (reading 'route')"
        );
        const storage = recoveryStorage();
        const reload = jest.fn();

        expect(
            loadLazyModule(
                "route-evaluation-failure",
                () => {
                    return Promise.try(() => {
                        throw evaluationError;
                    });
                },
                { reload, storage }
            )
        ).rejects.toBe(evaluationError);
        expect(reload).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it("reloads once for a missing chunk and rejects a repeated failure", async () => {
        const importError = new TypeError("Failed to fetch dynamically imported module");
        const storage = recoveryStorage();
        const reload = jest.fn();
        const firstImport = loadLazyModule(
            "route-reports",
            () => {
                return Promise.try(() => {
                    throw importError;
                });
            },
            {
                now: () => 10_000,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.setItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-reports",
            "10000"
        );
        void firstImport;

        expect(
            loadLazyModule(
                "route-reports",
                () => {
                    return Promise.try(() => {
                        throw importError;
                    });
                },
                {
                    now: () => 10_001,
                    reload,
                    storage,
                }
            )
        ).rejects.toBe(importError);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("allows another recovery reload after the cooldown", async () => {
        const importError = new TypeError("Importing a module script failed");
        const storage = recoveryStorage("10000");
        const reload = jest.fn();
        const importRequest = loadLazyModule(
            "route-database",
            () => {
                return Promise.try(() => {
                    throw importError;
                });
            },
            {
                now: () => 70_001,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.setItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-database",
            "70001"
        );
        void importRequest;
    });

    it("recovers when a stored reload timestamp is later than the current clock", async () => {
        const importError = new TypeError("Importing a module script failed");
        const storage = recoveryStorage("90000");
        const reload = jest.fn();
        const importRequest = loadLazyModule(
            "route-clock-reset",
            () => {
                return Promise.try(() => {
                    throw importError;
                });
            },
            {
                now: () => 30_000,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.setItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-clock-reset",
            "30000"
        );
        void importRequest;
    });

    it("uses the in-memory loop guard when storage is unavailable", async () => {
        const importError = new TypeError("error loading dynamically imported module");
        const storage = {
            getItem: jest.fn(() => {
                throw new Error("storage unavailable");
            }),
            removeItem: jest.fn(() => {
                throw new Error("storage unavailable");
            }),
            setItem: jest.fn(() => {
                throw new Error("storage unavailable");
            }),
        };
        const reload = jest.fn();
        const firstImport = loadLazyModule(
            "chat-markdown-storage-failure",
            () => {
                return Promise.try(() => {
                    throw importError;
                });
            },
            {
                now: () => 20_000,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        void firstImport;

        expect(
            loadLazyModule(
                "chat-markdown-storage-failure",
                () => {
                    return Promise.try(() => {
                        throw importError;
                    });
                },
                {
                    now: () => 20_001,
                    reload,
                    storage,
                }
            )
        ).rejects.toBe(importError);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(
            loadLazyModule(
                "chat-markdown-storage-failure",
                () => Promise.try(() => "loaded"),
                {
                    storage,
                }
            )
        ).resolves.toBe("loaded");
    });

    it("surfaces the import error when the browser reload cannot start", () => {
        const importError = new TypeError("Failed to fetch dynamically imported module");
        const storage = recoveryStorage("invalid timestamp");

        expect(
            loadLazyModule(
                "route-delivery-reload-failure",
                () => {
                    return Promise.try(() => {
                        throw importError;
                    });
                },
                {
                    now: () => 30_000,
                    reload: () => {
                        throw new Error("navigation unavailable");
                    },
                    storage,
                }
            )
        ).rejects.toBe(importError);
    });
});
