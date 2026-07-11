import { createServer } from "node:http";
import { postgraphile } from "postgraphile";
import { grafserv } from "postgraphile/grafserv/express/v4";
import { preset } from "./preset.js";
import { app } from "./app.js";
import { PORT } from "./env.js";
import { logger } from "./logger.js";
import { startBlockCacheInvalidator } from "./cache/block-cache.js";

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
