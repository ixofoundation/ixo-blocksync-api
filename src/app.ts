import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  TRUST_PROXY,
} from "./env.js";
import { pool } from "./db.js";
import { claimsRouter } from "./rest/claims.js";
import { ipfsRouter } from "./rest/ipfs.js";
import {
  blockCacheMiddleware,
  blockCacheStats,
} from "./cache/block-cache.js";

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 1 second",
});

export const app = express();
app.set("trust proxy", TRUST_PROXY);

app.use(cors());
app.use(compression());
// CSP disabled so Ruru (GraphiQL) can run; the API itself serves JSON only.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(limiter);
// Serves the exported schema at /graphql/schema.graphql like ixo-blocksync.
app.use(express.static("public"));

app.get("/", (_req, res) => {
  res.send("API is Running");
});

// Liveness/readiness: verifies a database round-trip.
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, cache: blockCacheStats() });
  } catch (error: any) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

// Block-aware response cache for GraphQL POSTs. express.json() parses the
// body (grafserv accepts a framework-parsed req.body); limit matches
// grafserv's maxRequestLength.
app.use("/graphql", express.json({ limit: "500kb" }), blockCacheMiddleware);

app.use(claimsRouter);
app.use(ipfsRouter);

// NOTE: grafserv (the GraphQL endpoint) is attached in index.ts AFTER this
// middleware stack, so CORS / rate limiting / compression apply to /graphql
// exactly as they do in ixo-blocksync.
