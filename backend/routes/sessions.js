// Sessions API routes
const gateway = require("../gateway");

// Promise-based request to gateway
function gatewayRequest(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const gw = gateway.getGatewayWs ? gateway.getGatewayWs() : null;
        if (!gw || gw.readyState !== 1) {
            reject(new Error("Gateway not connected"));
            return;
        }

        const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        const timer = setTimeout(() => {
            reject(new Error("Request timeout"));
        }, timeout);

        const handler = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) {
                    clearTimeout(timer);
                    gw.off("message", handler);
                    if (msg.ok) {
                        resolve(msg.payload);
                    } else {
                        reject(new Error(msg.error?.message || "Request failed"));
                    }
                }
            } catch (e) {}
        };

        gw.on("message", handler);
        gw.send(JSON.stringify({ type: "req", id, method, params }));
    });
}

module.exports = function(app) {
    // Get session history
    app.get("/api/sessions/:key/history", async (req, res) => {
        try {
            const key = req.params.key;
            
            // Try to get history from gateway
            const gw = require("../gateway");
            const gwWs = gw.getGatewayWs ? gw.getGatewayWs() : null;
            
            if (!gwWs || gwWs.readyState !== 1) {
                return res.status(503).json({ error: "Gateway not connected" });
            }

            const result = await new Promise((resolve, reject) => {
                const id = "history-" + Date.now();
                const timer = setTimeout(() => reject(new Error("Timeout")), 10000);
                
                const handler = (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id === id) {
                            clearTimeout(timer);
                            gwWs.off("message", handler);
                            resolve(msg);
                        }
                    } catch (e) {}
                };
                
                gwWs.on("message", handler);
                gwWs.send(JSON.stringify({
                    type: "req",
                    id,
                    method: "sessions.history",
                    params: { key }
                }));
            });

            if (result.ok && result.payload) {
                // Transform messages if needed
                const messages = result.payload.messages || result.payload || [];
                res.json({ messages });
            } else {
                // Return empty history if method not available
                res.json({ messages: [] });
            }
        } catch (e) {
            console.error("[Sessions] History error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Session actions (pause, resume, kill)
    app.post("/api/sessions/:key/action", async (req, res) => {
        try {
            const key = req.params.key;
            const { action } = req.body;
            
            const gw = require("../gateway");
            const gwWs = gw.getGatewayWs ? gw.getGatewayWs() : null;
            
            if (!gwWs || gwWs.readyState !== 1) {
                return res.status(503).json({ error: "Gateway not connected" });
            }

            const result = await new Promise((resolve, reject) => {
                const id = "action-" + Date.now();
                const timer = setTimeout(() => reject(new Error("Timeout")), 10000);
                
                const handler = (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id === id) {
                            clearTimeout(timer);
                            gwWs.off("message", handler);
                            resolve(msg);
                        }
                    } catch (e) {}
                };
                
                gwWs.on("message", handler);
                
                let method = "sessions.pause";
                if (action === "resume") method = "sessions.resume";
                if (action === "kill") method = "sessions.delete";
                
                gwWs.send(JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params: { key }
                }));
            });

            res.json({ ok: result.ok, error: result.error });
        } catch (e) {
            console.error("[Sessions] Action error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
};
