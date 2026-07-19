// Vercel serverless entry: all /api/* requests are rewritten here (vercel.json)
// and handled by the same Express app the Hetzner deployment runs.
import app from "../server/server.js";
export default app;
