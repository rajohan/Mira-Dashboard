// Metrics API routes
const { getMetrics } = require("../metrics");

module.exports = function(app) {
    app.get("/api/metrics", (req, res) => {
        try {
            res.json(getMetrics());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
