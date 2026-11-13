import WebSocket from 'ws';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

const SARVAM_URL =
    'wss://api.sarvam.ai/speech-to-text-realtime/ws?language_code=en-IN&mode=codemix&stream_type=fast';

export const transcriptStreamKey = (sessionId) => `stream:transcripts:${sessionId}`;

export class LiveTranscriptionManager {
    constructor(sessionId, clientWs) {
        this.sessionId = sessionId;
        this.clientWs = clientWs;
        this.sarvamWs = null;
        this.sequenceNumber = 0;
        this.pingInterval = null;
        this.inFlight = new Set();
        this.closed = false;
    }

    async initialize() {
        const last = await prisma.transcriptChunk.aggregate({
            where: { sessionId: this.sessionId },
            _max: { sequence: true }
        });
        this.sequenceNumber = last._max.sequence ?? 0;

        if (this.closed) return; // client left while we were reading the DB

        this.sarvamWs = new WebSocket(SARVAM_URL, {
            headers: { 'Api-Subscription-Key': process.env.SARVAM_API_KEY }
        });

        this.sarvamWs.on('error', (err) => console.error('Sarvam WS error:', err.message));

        this.sarvamWs.on('message', (data) => {
            const task = this.handleSarvamMessage(data).catch((err) =>
                console.error('Error handling Sarvam payload:', err.message)
            );
            this.inFlight.add(task);
            task.finally(() => this.inFlight.delete(task));
        });

        this.pingInterval = setInterval(() => {
            if (this.sarvamWs.readyState === WebSocket.OPEN) {
                this.sarvamWs.send(JSON.stringify({ event: 'ping' }));
            }
        }, 15000);
    }

    sendToClient(payload) {
        if (this.clientWs.readyState === WebSocket.OPEN) {
            this.clientWs.send(JSON.stringify(payload));
        }
    }

    async handleSarvamMessage(data) {
        const msg = JSON.parse(data.toString());

        if (msg.event === 'transcript.partial') {
            this.sendToClient({ type: 'TRANSCRIPT_PARTIAL', text: msg.text });
        } else if (msg.event === 'transcript.final' && msg.text?.trim()) {
            await this.commitFinal(msg.text);
        } else if (msg.event === 'error') {
            console.error(`Sarvam API error (${msg.code}): ${msg.message}`);
        }
    }

    async commitFinal(rawText) {
        const text = rawText.trim();
        if (!text) return;
        const sequence = ++this.sequenceNumber; 

        this.sendToClient({ type: 'TRANSCRIPT_FINAL', chunk: { sequence, text, status: 'PENDING' } });

        const chunk = await prisma.transcriptChunk.create({
            data: { sessionId: this.sessionId, sequence, text, status: 'PENDING' }
        });
        await redis.xadd(
            transcriptStreamKey(this.sessionId),
            '*',
            'chunkId', chunk.id,
            'text', text,
            'sequence', String(sequence)
        );
    }

    ingestText(text) {
        const task = this.commitFinal(text).catch((err) =>
            console.error('Error ingesting text:', err.message)
        );
        this.inFlight.add(task);
        task.finally(() => this.inFlight.delete(task));
    }

    handleAudioChunk(buffer) {
        if (this.sarvamWs?.readyState === WebSocket.OPEN) {
            this.sarvamWs.send(JSON.stringify({ event: 'audio_input', audio: buffer.toString('base64') }));
        }
    }

    async close() {
        this.closed = true;
        clearInterval(this.pingInterval);

        const ws = this.sarvamWs;
        if (ws && ws.readyState !== WebSocket.CLOSED) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 5000);
                ws.once('close', () => {
                    clearTimeout(timer);
                    resolve();
                });

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ event: 'end' }));
                } else {
                    ws.terminate();
                }
            });
            ws.terminate();
        }

        await Promise.allSettled([...this.inFlight]);
    }
}
