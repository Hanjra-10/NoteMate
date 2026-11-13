import { WebSocketServer, WebSocket } from 'ws';
import { authenticateWs } from '../middleware/auth.js';
import { validateSessionAccess } from '../middleware/ownership.js';
import { LiveTranscriptionManager } from './transcriptionService.js';
import { answerStudentQuestion } from './questionAnsweringService.js';
import { processTranscriptStream } from '../workers/noteGenerationWorker.js';

const liveSessions = new Map();

export async function endLiveSession(sessionId) {
    await liveSessions.get(sessionId)?.stop();
}

function reject(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

export function initWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (request, socket, head) => {
        try {
            const user = authenticateWs(request);
            if (!user) return reject(socket, 401, 'Unauthorized');

            const sessionId = new URL(request.url, 'http://localhost').searchParams.get('sessionId');
            const session = sessionId && await validateSessionAccess(user.id, sessionId);
            if (!session || session.status !== 'LIVE') {
                return reject(socket, 404, 'Live session not found');
            }

            await liveSessions.get(session.id)?.stop();

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request, user, session);
            });
        } catch (err) {
            console.error('WS upgrade error:', err);
            reject(socket, 500, 'Internal Server Error');
        }
    });

    wss.on('connection', (clientWs, request, user, session) => {
        const sessionId = session.id;
        console.log(`User ${user.id} connected to session ${sessionId}`);

        const transcription = new LiveTranscriptionManager(sessionId, clientWs);
        const stopNoteWorker = processTranscriptStream(sessionId, clientWs);

        // Send existing notes and recent transcripts on connect
        Promise.all([
            prisma.noteChunk.findMany({
                where: { sessionId },
                orderBy: { sortOrder: 'asc' }
            }),
            prisma.transcriptChunk.findMany({
                where: { sessionId },
                orderBy: { sequence: 'asc' },
                take: 20
            })
        ]).then(([notes, transcripts]) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                if (notes.length > 0) {
                    clientWs.send(JSON.stringify({ type: 'NOTE_BLOCKS_UPDATED', blocks: notes }));
                }
                if (transcripts.length > 0) {
                    clientWs.send(JSON.stringify({ type: 'RECENT_TRANSCRIPTS', chunks: transcripts }));
                }
            }
        }).catch((err) => console.error('Initial session data error:', err.message));

        let stopping = null;
        const stop = () => (stopping ??= (async () => {
            try {
                await transcription.close();
                await stopNoteWorker();
            } catch (err) {
                console.error(`Error stopping session ${sessionId}:`, err);
            } finally {
                liveSessions.delete(sessionId);
                if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
            }
        })());
        liveSessions.set(sessionId, { stop });

        transcription.initialize().catch((err) => {
            console.error('Transcription init error:', err);
            clientWs.close();
        });

        clientWs.on('error', (err) => console.error('Client WS error:', err.message));

        clientWs.on('message', (data, isBinary) => {
            if (isBinary) {
                transcription.handleAudioChunk(data);
                return;
            }

            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }

            if (msg.type === 'TRANSCRIPT_TEXT' && typeof msg.text === 'string') {
                transcription.ingestText(msg.text);
            } else if (msg.type === 'QUESTION' && typeof msg.question === 'string' && msg.question.trim()) {
                answerStudentQuestion({
                    userId: user.id,
                    sessionId,
                    subjectId: session.subjectId,
                    question: msg.question,
                    clientWs
                }).catch((err) => {
                    console.error('QA error:', err);
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ type: 'QA_ERROR', error: 'Failed to answer question.' }));
                    }
                });
            }
        });

        clientWs.on('close', stop);
    });
}
