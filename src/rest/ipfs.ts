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

// Same contract as ixo-blocksync GET /api/ipfs/:cid
ipfsRouter.get("/api/ipfs/:cid", async (req, res) => {
  try {
    const doc = await getIpfsDocument(req.params.cid);
    if (!doc || "error" in doc) throw new Error("Document not found");
    const buf = Buffer.from(doc.data);
    res.writeHead(200, {
      "Content-Type": doc.contentType,
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch (error: any) {
    res.status(404).send(error.message || "Document not found");
  }
});
