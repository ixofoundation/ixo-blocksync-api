import { Router } from "express";
import axios from "axios";
import axiosRetry from "axios-retry";
import { IPFS_GATEWAY } from "../env.js";
import { ipfsGatewayRateLimiter } from "../util/rate-limiter.js";
import { sleep } from "../util/sleep.js";

axiosRetry(axios, {
  retries: 3,
  retryDelay: () => 500,
});

// Ported from ixo-blocksync src/handlers/ipfs_handler.ts - a rate-limited
// proxy to the ixo IPFS gateway (the Ipfs DB table was dropped long ago).
const getIpfsDocument = async (
  cid: string
): Promise<
  { cid: string; contentType: string; data: Buffer } | { error: string }
> => {
  try {
    await ipfsGatewayRateLimiter.removeTokens(1);
  } catch {
    await sleep(1000);
    return await getIpfsDocument(cid);
  }

  let res;
  try {
    res = await axios.get(`${IPFS_GATEWAY}/ipfs/${cid}`, {
      responseType: "arraybuffer",
    });
  } catch (error: any) {
    if (error.response && error.response.status === 429) {
      await sleep(1000);
      return await getIpfsDocument(cid);
    }
    if (error.response) {
      throw new Error(
        `failed to get ${cid} - [${error.response.status}] ${error.response.statusText}`
      );
    }
    throw new Error(`failed to get ${cid} - ${error}`);
  }

  if (res.status !== 200) {
    if (res.status === 429) {
      await sleep(1000);
      return await getIpfsDocument(cid);
    }
    throw new Error(`failed to get ${cid} - [${res.status}] ${res.statusText}`);
  }

  const type = res.headers["content-type"] || "";
  // html can be directories instead of files - unsupported, same as v4
  if (!type || type.includes("text/html")) {
    return { error: "invalid content type" };
  }

  return {
    cid: cid,
    contentType: type,
    data: res.data,
  };
};

export const ipfsRouter = Router();

// Only content types that are safe to render inline from the API origin are
// forwarded as-is. Anything else - notably image/svg+xml and other XML types,
// which execute scripts in browsers - is served as a generic byte stream so
// attacker-pinned IPFS content can never run code on this origin. Images stay
// hot-linkable (clients embed these URLs as <img src>).
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/json",
  "application/pdf",
  "text/plain",
  "video/mp4",
  "audio/mpeg",
]);

// Same contract as ixo-blocksync GET /api/ipfs/:cid (hardened headers)
ipfsRouter.get("/api/ipfs/:cid", async (req, res) => {
  try {
    const doc = await getIpfsDocument(req.params.cid);
    if (!doc || "error" in doc) throw new Error("Document not found");
    const buf = Buffer.from(doc.data);
    const baseType = doc.contentType.split(";")[0].trim().toLowerCase();
    res.writeHead(200, {
      "Content-Type": INLINE_SAFE_TYPES.has(baseType)
        ? doc.contentType
        : "application/octet-stream",
      "Content-Length": buf.length,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(buf);
  } catch (error: any) {
    res.status(404).send(error.message || "Document not found");
  }
});
