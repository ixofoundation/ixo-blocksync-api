import { RateLimiter } from "limiter";

// The ixo IPFS gateway allows ~200 requests per minute; mirror the limiter
// ixo-blocksync uses so /api/ipfs/:cid never trips the upstream limit.
export const ipfsGatewayRateLimiter = new RateLimiter({
  tokensPerInterval: 200,
  interval: "minute",
});
