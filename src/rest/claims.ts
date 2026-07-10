import { Router } from "express";
import { getCollectionClaims } from "../loaders/claims.js";

export const claimsRouter = Router();

// Same contract as ixo-blocksync GET /api/claims/collection/:id/claims
claimsRouter.get("/api/claims/collection/:id/claims", async (req, res) => {
  try {
    const claims = await getCollectionClaims(
      req.params.id,
      req.query.status as string,
      req.query.type as string,
      req.query.take as string,
      req.query.cursor as string,
      req.query.orderBy as any
    );
    res.json(claims);
  } catch (error: any) {
    res.status(500).send(error.message);
  }
});
