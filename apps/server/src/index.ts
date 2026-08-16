import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
if (config.authToken === "development-only-token" && process.env.NODE_ENV === "production") throw new Error("PM_AUTH_TOKEN must be set in production");
const app = await buildApp(config);
await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await app.close(); process.exit(0); });
