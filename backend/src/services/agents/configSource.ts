import FS from "node:fs";
import Path from "node:path";

import type { AgentsConfig } from "../../../../contracts/agents.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { getOpenclawRoot } from "./agentPaths.ts";

const logger = createStructuredLogger("agents");

/**
 * Reads the configured OpenClaw agent list from a guarded configuration file.
 * @returns Parsed agent configuration, or undefined when unavailable or unsafe.
 */
export function parseAgentsConfig(): AgentsConfig | undefined {
    const configPath = Path.join(getOpenclawRoot(), "openclaw.json");

    try {
        if (!FS.existsSync(configPath)) {
            return undefined;
        }

        const configStat = FS.lstatSync(configPath);
        if (configStat.isSymbolicLink() || configStat.nlink > 1) {
            return undefined;
        }
        const realRoot = FS.realpathSync(getOpenclawRoot());
        const realPath = FS.realpathSync(configPath);
        if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${Path.sep}`)) {
            return undefined;
        }

        const fd = FS.openSync(
            Buffer.from(realPath),
            FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
        );
        let content: string;
        try {
            content = FS.readFileSync(fd, "utf8");
        } finally {
            FS.closeSync(fd);
        }
        const parsed = Bun.JSON5.parse(content) as { agents?: AgentsConfig };

        if (parsed.agents && Array.isArray(parsed.agents.list)) {
            return parsed.agents;
        }
        return undefined;
    } catch (error) {
        logger.error("agents.openclaw_config_parse_failed", {
            error,
            path: configPath,
        });
        return undefined;
    }
}
