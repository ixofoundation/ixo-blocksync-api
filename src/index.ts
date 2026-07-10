import { createServer } from "node:http";
import { postgraphile } from "postgraphile";
import { grafserv } from "postgraphile/grafserv/express/v4";
import { preset } from "./preset.js";
import { app } from "./app.js";
import { PORT } from "./env.js";

const pgl = postgraphile(preset);
const serv = pgl.createServ(grafserv);

const server = createServer(app);
server.on("error", (err) => {
  console.error("http server error:", err);
});

await serv.addTo(app, server);

server.listen(PORT, () => {
  console.log(`ixo-blocksync-api listening on ${PORT}`);
  console.log(`  graphql:  http://localhost:${PORT}/graphql`);
  console.log(`  graphiql: http://localhost:${PORT}/graphiql`);
});
