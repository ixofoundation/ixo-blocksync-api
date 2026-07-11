import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { postgraphile } from "postgraphile";
import { grafserv } from "postgraphile/grafserv/express/v4";
import { preset } from "./preset.js";
import { app } from "./app.js";
import { EXPORT_SCHEMA_PATH, PORT } from "./env.js";
import { logger } from "./logger.js";
import { startBlockCacheInvalidator } from "./cache/block-cache.js";

// grafserv writes the SDL export on boot but does not create the directory,
// and the container image ships without it - ensure it exists so the export
// (served at GET /graphql/schema.graphql via express.static) works.
if (EXPORT_SCHEMA_PATH) mkdirSync(dirname(EXPORT_SCHEMA_PATH), { recursive: true });

const pgl = postgraphile(preset);
const serv = pgl.createServ(grafserv);

const server = createServer(app);
server.on("error", (err) => {
  logger.error({ err: err.message }, "http server error");
});

await serv.addTo(app, server);

startBlockCacheInvalidator();

server.listen(PORT, () => {
  logger.info(
    { port: PORT, graphql: `http://localhost:${PORT}/graphql`, graphiql: `http://localhost:${PORT}/graphiql` },
    "ixo-blocksync-api listening"
  );
});
