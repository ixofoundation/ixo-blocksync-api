import { createHash } from 'node:crypto';
import { parse, type OperationDefinitionNode } from 'graphql';
import type { RequestHandler } from 'express';
import { logger } from './logger.js';
import { LOG_SLOW_MS } from './env.js';

// ---------------------------------------------------------------------------
// Per-request analytics log: one JSON line per request with timing, size and
// (for /graphql) the operation name, root fields, query hash, cache result
// and an errors flag - the raw material for any later aggregation
// (p50/p95 per operation, hit rates, egress, per-client usage).
//
// Mount AFTER compression() (so byte counts are uncompressed payload sizes,
// which is what analytics wants) and BEFORE the rate limiter (so 429s are
// logged too). The GraphQL body is read at response time, after express.json
// has populated req.body further down the chain.
// ---------------------------------------------------------------------------

interface GqlInfo {
	op: string | null;
	type: string;
	roots: string[];
}

// Parsing the query is the only reliable way to get operation type and root
// fields, but repeat queries (the overwhelmingly common case) shouldn't pay
// for it twice: LRU keyed by query hash + operationName.
const parseCache = new Map<string, GqlInfo | null>(); // null = unparseable
const PARSE_CACHE_MAX = 1000;

const gqlInfoFor = (query: string, operationName: string | null, hash: string): GqlInfo | null => {
	const cacheKey = `${hash}:${operationName ?? ''}`;
	if (parseCache.has(cacheKey)) {
		const cached = parseCache.get(cacheKey)!;
		parseCache.delete(cacheKey);
		parseCache.set(cacheKey, cached);
		return cached;
	}
	let info: GqlInfo | null = null;
	try {
		const doc = parse(query);
		const ops = doc.definitions.filter(
			(d): d is OperationDefinitionNode => d.kind === 'OperationDefinition'
		);
		const op = (operationName ? ops.find(o => o.name?.value === operationName) : undefined) ?? ops[0];
		if (op) {
			const roots: string[] = [];
			for (const sel of op.selectionSet.selections) {
				if (sel.kind === 'Field') roots.push(sel.name.value);
			}
			info = { op: op.name?.value ?? null, type: op.operation, roots };
		}
	} catch {
		// unparseable query - grafserv rejects it too; log it as gql with no info
	}
	if (parseCache.size >= PARSE_CACHE_MAX) {
		const oldest = parseCache.keys().next().value;
		if (oldest !== undefined) parseCache.delete(oldest);
	}
	parseCache.set(cacheKey, info);
	return info;
};

// Liveness probes would dominate the log volume with zero analytics value.
const SKIP_PATHS = new Set(['/', '/healthz']);

export const requestLogMiddleware: RequestHandler = (req, res, next) => {
	if (SKIP_PATHS.has(req.path)) return next();

	// Capture now: Express rewrites req.path/req.url inside path-mounted
	// middleware (e.g. app.use("/graphql", ...)), and a response that ends in
	// there (block-cache HITs do) fires 'finish' while the path is stripped.
	const path = req.path;
	const start = performance.now();
	let bytes = 0;
	// First bytes of the response, used to detect GraphQL errors: graphql-js
	// puts "errors" before "data" in the result object, so an errored response
	// starts {"errors": - full inspection would mean re-buffering/parsing
	// every response, which is not worth it for a log line.
	let head: string | null = null;

	const record = (chunk: unknown) => {
		if (chunk == null || typeof chunk === 'function') return;
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
		if (head === null && buf.length > 0) head = buf.subarray(0, 64).toString('utf8');
		bytes += buf.length;
	};

	const origWrite = res.write.bind(res);
	const origEnd = res.end.bind(res);
	(res as any).write = (chunk: any, ...args: any[]) => {
		record(chunk);
		return (origWrite as any)(chunk, ...args);
	};
	(res as any).end = (chunk?: any, ...args: any[]) => {
		record(chunk);
		return (origEnd as any)(chunk, ...args);
	};

	let logged = false;
	const emit = () => {
		if (logged) return;
		logged = true;
		const durationMs = Math.round((performance.now() - start) * 10) / 10;

		const entry: Record<string, unknown> = {
			method: req.method,
			path,
			status: res.statusCode,
			durationMs,
			bytes,
			ip: req.ip,
		};
		const ua = req.get('user-agent');
		if (ua) entry.ua = ua;
		const origin = req.get('origin');
		if (origin) entry.origin = origin;
		if (!res.writableFinished) entry.aborted = true;

		const body = req.body;
		if (path.startsWith('/graphql') && req.method === 'POST' && body && typeof body.query === 'string') {
			const hash = createHash('sha256').update(body.query).digest('hex').slice(0, 16);
			const operationName = typeof body.operationName === 'string' ? body.operationName : null;
			const info = gqlInfoFor(body.query, operationName, hash);
			entry.gql = {
				op: info?.op ?? operationName,
				type: info?.type ?? null,
				roots: info?.roots ?? [],
				hash,
				cache: (res.getHeader('x-cache') as string | undefined) ?? 'BYPASS',
				errors: head !== null && head.includes('"errors"'),
			};
		}

		if (res.statusCode >= 500) logger.error(entry, 'request');
		else if (res.statusCode >= 400 || durationMs >= LOG_SLOW_MS) logger.warn(entry, 'request');
		else logger.info(entry, 'request');
	};

	res.on('finish', emit);
	res.on('close', emit); // client aborts never fire 'finish'

	next();
};
