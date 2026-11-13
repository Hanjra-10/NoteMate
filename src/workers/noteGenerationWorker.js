import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { generateIncrementalNotes } from '../services/geminiNoteEngine.js';
import { transcriptStreamKey } from '../services/transcriptionService.js';

const STREAM_GROUP = 'note_generators';
const CONSUMER_NAME = `worker_${process.pid}`;
const READ_BLOCK_MS = 2000;     // max idle wait for new transcript lines
const FLUSH_EVERY_MS = 10000;   // at most one note update per this interval
const WS_OPEN = 1;

export function processTranscriptStream(sessionId, clientWs) {
    const streamKey = transcriptStreamKey(sessionId);

    const reader = redis.duplicate();

    let batch = []; 
    let lastFlushAt = 0; 
    let running = true;

    async function pull(startId, blockMs) {
        const args = ['GROUP', STREAM_GROUP, CONSUMER_NAME, 'COUNT', 10];
        if (blockMs) args.push('BLOCK', blockMs);
        args.push('STREAMS', streamKey, startId);

        const entries = await reader.xreadgroup(...args);
        const records = entries?.[0]?.[1] ?? [];

        for (const [id, fields] of records) {
            const data = {};
            for (let i = 0; i < fields.length; i += 2) data[fields[i]] = fields[i + 1];
            batch.push({ id, chunkId: data.chunkId, text: data.text });
        }
        return records.length ? records[records.length - 1][0] : null;
    }

    async function flushBatch() {
        if (batch.length === 0) return;
        lastFlushAt = Date.now(); 
        try {
            const changedBlocks = await generateIncrementalNotes(
                sessionId,
                batch.map(b => b.text).join(' ')
            );

            await prisma.transcriptChunk.updateMany({
                where: { id: { in: batch.map(b => b.chunkId) } },
                data: { status: 'PROCESSED', processedAt: new Date() }
            });
            await redis.xack(streamKey, STREAM_GROUP, ...batch.map(b => b.id));

            batch = [];

            if (clientWs.readyState === WS_OPEN) {
                clientWs.send(JSON.stringify({ type: 'NOTE_BLOCKS_UPDATED', blocks: changedBlocks }));
            }
        } catch (error) {
            console.error('Failed to process batch:', error);
        }
    }

    const flushDueIn = () => lastFlushAt + FLUSH_EVERY_MS - Date.now();

    const loop = (async () => {
        try {
            await reader.xgroup('CREATE', streamKey, STREAM_GROUP, '$', 'MKSTREAM');
        } catch (err) {
            if (!String(err.message).includes('BUSYGROUP')) console.error('xgroup error:', err.message);
        }

        try {
            let cursor = '0';
            while ((cursor = await pull(cursor))) { /* page through pending entries */ }
        } catch (err) {
            console.error('Pending recovery error:', err.message);
        }

        while (running) {
            try {
                const wait = batch.length > 0 ? Math.min(READ_BLOCK_MS, Math.max(50, flushDueIn())) : READ_BLOCK_MS;
                await pull('>', wait);
                if (batch.length > 0 && flushDueIn() <= 0) await flushBatch();
            } catch (err) {
                console.error('Note worker error:', err.message);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    })();

    return async function stop() {
        running = false;
        await loop;

        try {
            while (await pull('>')) {  }
            await flushBatch();
        } catch (err) {
            console.error('Final note flush error:', err.message);
        }
        reader.disconnect();
    };
}
