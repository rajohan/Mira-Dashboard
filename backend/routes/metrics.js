// Metrics API routes
const os = require("os");
const { execSync } = require("child_process");
const gateway = require("../gateway");

function getSystemMetrics() {
    // CPU
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    
    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    
    // Disk
    let diskTotal = 0;
    let diskUsed = 0;
    let diskPercent = 0;
    
    try {
        const dfOutput = execSync("df -B1 / | tail -1", { encoding: "utf8" });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
            diskTotal = parseInt(parts[1], 10);
            diskUsed = parseInt(parts[2], 10);
            diskPercent = parseInt(parts[4], 10);
        }
    } catch (e) {
        console.error("[Metrics] df error:", e.message);
    }
    
    // Uptime
    const uptime = os.uptime();
    
    return {
        cpu: {
            count: cpus.length,
            model: cpus[0]?.model || "Unknown",
            loadAvg: loadAvg.map((v) => Math.round(v * 100) / 100),
            loadPercent: Math.round((loadAvg[0] / cpus.length) * 100),
        },
        memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            percent: memPercent,
            totalGB: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
            usedGB: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
        },
        disk: {
            total: diskTotal,
            used: diskUsed,
            percent: diskPercent,
            totalGB: Math.round((diskTotal / 1024 / 1024 / 1024) * 10) / 10,
            usedGB: Math.round((diskUsed / 1024 / 1024 / 1024) * 10) / 10,
        },
        system: {
            uptime,
            platform: os.platform(),
            hostname: os.hostname(),
        },
        timestamp: Date.now(),
    };
}

function getTokenMetrics() {
    const sessions = gateway.getSessions();
    let totalTokens = 0;
    const byModel = {};
    const sessionsByModel = {};
    const byAgent = [];
    
    for (const session of sessions) {
        const model = session.model || "unknown";
        const tokens = session.tokenCount || 0;
        
        totalTokens += tokens;
        byModel[model] = (byModel[model] || 0) + tokens;
        
        // Count sessions by model
        const modelKey = model.split("/").pop(); // Remove provider prefix
        sessionsByModel[modelKey] = (sessionsByModel[modelKey] || 0) + 1;
        
        // Agent data
        if (session.displayLabel || session.label) {
            byAgent.push({
                label: session.displayLabel || session.label || "Unknown",
                model: model,
                tokens: tokens,
                type: session.type || "Unknown",
            });
        }
    }
    
    return {
        total: totalTokens,
        byModel,
        sessionsByModel,
        byAgent: byAgent.sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    };
}

module.exports = function(app) {
    app.get("/api/metrics", (req, res) => {
        try {
            const system = getSystemMetrics();
            const tokens = getTokenMetrics();
            
            res.json({
                ...system,
                tokens,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
