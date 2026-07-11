import { pino } from 'pino';
import { LOG_LEVEL } from './env.js';

// Single structured (JSON-lines) logger for the whole process, so stdout is
// uniformly machine-parseable and can be aggregated by any log pipeline
// (Loki, BigQuery, `kubectl logs | jq`, ...).
// `base: undefined` drops pid/hostname - the k8s collector labels pods already.
export const logger = pino({
	level: LOG_LEVEL,
	base: undefined,
	timestamp: pino.stdTimeFunctions.isoTime,
	// string level labels ("info") instead of pino's numeric defaults (30) -
	// friendlier for jq / Loki / SQL aggregation
	formatters: {
		level: label => ({ level: label }),
	},
});
