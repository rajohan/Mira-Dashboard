// Metrics API routes
const os = require("os");
const { execSync } = require("child_process");

function getMetrics() {
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

module.exports = function(app) {
    app.get("/api/metrics", (req, res) => {
        try {
            res.json(getMetrics());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
