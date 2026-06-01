import { serve } from "@hono/node-server";
import { createDocWorkerApp } from "./app";

const port = Number(process.env.PORT ?? 8080);
const app = createDocWorkerApp({ token: process.env.DOCWORKER_TOKEN });

serve({ fetch: app.fetch, port });
// eslint-disable-next-line no-console
console.log(`[docworker] listening on :${port}${process.env.TAILNET_PROXY_URL ? " (tailnet egress via proxy)" : ""}`);

export { createDocWorkerApp };
