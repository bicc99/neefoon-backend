import { pinoHttp } from 'pino-http';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Structured HTTP request/response logger.
 *
 * Why pino over morgan: JSON output is consumed natively by Railway and any
 * log aggregator we add later (Datadog, Loki, Cloudwatch) with no adapter.
 * Pretty-printing is dev-only via pino-pretty so terminal output stays readable
 * while production logs remain machine-parseable.
 *
 * Why redact: the Authorization header carries the Bearer API_KEY on every
 * authenticated request. Logging it once would expose the key in Railway logs
 * and any downstream sink permanently. Cookies are redacted for the same reason
 * even though we don't set any today; defence in depth costs nothing.
 *
 * Why custom serializers: pino-http's defaults dump every request/response
 * header and a noisy params object. The trimmed shape below logs only the
 * fields we'd actually search on during an incident.
 */
export const httpLogger = pinoHttp({
    // Spread so the key is absent in prod rather than set to undefined.
    // tsconfig has exactOptionalPropertyTypes, which rejects explicit undefined.
    ...(isDev
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
        : {}),

    redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[REDACTED]',
    },

    serializers: {
        req(req) {
            return {
                method: req.method,
                url: req.url,
                remoteAddress: req.remoteAddress,
            };
        },
        res(res) {
            return { statusCode: res.statusCode };
        },
    },

    // Demote routine traffic to debug-level so production logs show only
    // anomalies by default. 4xx is warn (client misbehaviour), 5xx is error.
    customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
    },
});
