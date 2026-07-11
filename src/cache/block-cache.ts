import pg from 'pg';
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { BLOCK_CACHE, BLOCK_CACHE_CHANNEL, BLOCK_CACHE_LISTEN_DATABASE_URL, BLOCK_CACHE_MAX_ENTRIES, BLOCK_CACHE_MAX_ENTRY_BYTES, BLOCK_CACHE_BACKSTOP_MS, DATABASE_USE_SSL } from '../env.js';

// ---------------------------------------------------------------------------
// Block-aware response cache.
//
// The database only changes when the indexer commits a block, and the indexer
// updates "Chain".blockHeight inside that same per-block transaction. A
// trigger on "Chain" (scripts/block-notify-trigger.sql) pg_notify's this
// process, which flushes the whole cache - so a cached response can never be
// staler than the database itself: freshness is defined by the chain, not a
// timer. Someone who transacts and immediately queries still sees their
// transaction, because the block that included it flushed the cache.
//
// Safety nets:
// - a cheap poll of "Chain".blockHeight every BLOCK_CACHE_BACKSTOP_MS bounds
//   staleness even if the trigger is missing or the LISTEN connection drops
// - the cache is flushed whenever the LISTEN connection (re)establishes,
//   covering notifications missed while disconnected
// - tokenomics* fields read the chain RPC (not the DB), so operations that
//   mention them are never cached
// ---------------------------------------------------------------------------

const cache = new Map<string, Buffer>(); // insertion order doubles as LRU order

let hits = 0;
let misses = 0;
let invalidations = 0;

export const blockCacheStats = () => ({
	enabled: BLOCK_CACHE,
	entries: cache.size,
	hits,
	misses,
	invalidations,
});

export const clearBlockCache = (): void => {
	if (cache.size > 0) {
		cache.clear();
		invalidations++;
	}
};

const keyFor = (body: any): string =>
	createHash('sha256')
		.update(JSON.stringify([body.query, body.variables ?? null, body.operationName ?? null]))
		.digest('hex');

const UNCACHEABLE = /\bmutation\b|tokenomics/i;

// Express middleware for POST /graphql. Relies on express.json() having
// parsed the body (grafserv accepts the pre-parsed req.body).
export const blockCacheMiddleware: RequestHandler = (req, res, next) => {
	if (!BLOCK_CACHE || req.method !== 'POST') return next();
	const body = req.body;
	if (!body || typeof body.query !== 'string' || UNCACHEABLE.test(body.query)) return next();

	const key = keyFor(body);
	const cached = cache.get(key);
	if (cached) {
		// refresh LRU position
		cache.delete(key);
		cache.set(key, cached);
		hits++;
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.setHeader('X-Cache', 'HIT');
		res.end(cached);
		return;
	}
	misses++;
	res.setHeader('X-Cache', 'MISS');

	// Buffer the (uncompressed - compression() wraps outside us) response and
	// store it on success. Never let caching break the response itself.
	const chunks: Buffer[] = [];
	let size = 0;
	let tooBig = false;
	const record = (chunk: any) => {
		if (tooBig || chunk == null || typeof chunk === 'function') return;
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > BLOCK_CACHE_MAX_ENTRY_BYTES) {
			tooBig = true;
			chunks.length = 0;
		} else {
			chunks.push(buf);
		}
	};

	const origWrite = res.write.bind(res);
	const origEnd = res.end.bind(res);
	(res as any).write = (chunk: any, ...args: any[]) => {
		record(chunk);
		return (origWrite as any)(chunk, ...args);
	};
	(res as any).end = (chunk?: any, ...args: any[]) => {
		record(chunk);
		const result = (origEnd as any)(chunk, ...args);
		try {
			// NOTE: no content-type check - grafserv sends headers via
			// writeHead(status, headers), which res.getHeader() does not reflect;
			// successfully parsing as a GraphQL result is the real gate.
			if (res.statusCode === 200 && !tooBig && chunks.length > 0) {
				const payload = Buffer.concat(chunks);
				const parsed = JSON.parse(payload.toString('utf8'));
				if (parsed && parsed.data !== undefined && parsed.errors === undefined) {
					if (cache.size >= BLOCK_CACHE_MAX_ENTRIES) {
						const oldest = cache.keys().next().value;
						if (oldest !== undefined) cache.delete(oldest);
					}
					cache.set(key, payload);
				}
			}
		} catch {
			// malformed/partial payloads are simply not cached
		}
		return result;
	};
	next();
};

// Dedicated LISTEN connection (pools recycle clients; a listener must hold
// one open) with reconnect + missed-notification handling.
export const startBlockCacheInvalidator = (): void => {
	if (!BLOCK_CACHE) return;

	let lastSeenHeight: string | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let attempts = 0;
	const scheduleReconnect = () => {
		if (reconnectTimer) return;
		// back off after repeated failures (e.g. LISTEN is impossible through
		// pgbouncer transaction pooling) - the poll backstop keeps the cache
		// correct meanwhile, so don't spam reconnects/logs
		const delay = attempts < 3 ? 2000 : 30000;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	};

	const connect = async () => {
		attempts++;
		const client = new pg.Client({
			application_name: 'Blocksync-api-cache',
			connectionString: BLOCK_CACHE_LISTEN_DATABASE_URL,
			...(DATABASE_USE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
		});
		client.on('error', err => {
			logger.error({ err: err.message }, 'block-cache: LISTEN connection error');
			clearBlockCache();
			try {
				client.end().catch(() => {});
			} catch {}
			scheduleReconnect();
		});
		client.on('notification', msg => {
			if (msg.channel === BLOCK_CACHE_CHANNEL) {
				clearBlockCache();
				if (msg.payload) lastSeenHeight = msg.payload;
			}
		});
		try {
			await client.connect();
			await client.query(`LISTEN "${BLOCK_CACHE_CHANNEL}"`);
			attempts = 0;
			// anything cached while we weren't listening is unverifiable - drop it
			clearBlockCache();
			logger.info(`block-cache: listening for new blocks on "${BLOCK_CACHE_CHANNEL}"`);
		} catch (err: any) {
			logger.error({ err: err.message }, 'block-cache: LISTEN connect failed');
			scheduleReconnect();
		}
	};
	connect();

	// Backstop poll: bounds staleness to BLOCK_CACHE_BACKSTOP_MS even if the
	// trigger is absent or notifications are lost. One PK-row read.
	setInterval(async () => {
		try {
			const r = await pool.query('SELECT MAX("blockHeight")::text AS h FROM "Chain"');
			const h: string | null = r.rows[0]?.h ?? null;
			if (h !== lastSeenHeight) {
				if (lastSeenHeight !== null) clearBlockCache();
				lastSeenHeight = h;
			}
		} catch {
			// transient DB errors: the LISTEN path still covers invalidation
		}
	}, BLOCK_CACHE_BACKSTOP_MS).unref();
};
