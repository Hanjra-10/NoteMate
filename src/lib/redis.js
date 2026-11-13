import 'dotenv/config';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    console.warn('[Upstash Redis] Warning: REDIS_URL is not set in .env');
}

const isUpstash = redisUrl?.includes('upstash.io') || redisUrl?.startsWith('rediss://');

export const redis = new Redis(redisUrl || 'redis://localhost:6379', {
    tls: isUpstash ? { rejectUnauthorized: false } : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
        return Math.min(times * 100, 3000);
    }
});

redis.on('connect', () => {
    console.log('[Upstash Redis] Successfully connected to cloud instance.');
});

redis.on('error', (err) => {
    console.error('[Upstash Redis Error]', err.message);
});
