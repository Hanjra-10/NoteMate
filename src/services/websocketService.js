import { WebSocketServer, WebSocket } from 'ws';
import { prisma } from '../lib/prisma.js';
import { parseWsAuth } from '../middleware/auth.js';
import { validateSessionAccess } from '../middleware/ownership.js';
import { LiveTranscriptionManager } from './transcriptionService.js';
import { answerStudentQuestion } from './questionAnsweringService.js';
import { processTranscriptStream } from '../workers/noteGenerationWorker.js';

const liveSessions = new Map();

export async function endLiveSession(sessionId) {
    const existing = liveSessions.get(sessionId);
    if (existing) {
        liveSessions.delete(sessionId);
        await existing.stop().catch(err => console.error(`Error ending session ${sessionId}:`, err.message));
    }
}

function safeSend(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
        } catch (err) {
            console.warn('[WS] Failed to send message:', err.message);
        }
    }
}

export function initWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (request, socket, head) => {
        try {
            console.log(`[WS Upgrade] Incoming request: ${request.url}`);
            const auth = parseWsAuth(request);

            if (auth.error || !auth.user) {
                console.warn(`[WS Upgrade] Auth failed: ${auth.error || 'Unauthorized'}`);
                wss.handleUpgrade(request, socket, head, (ws) => {
                    safeSend(ws, { type: 'ERROR', message: auth.error || 'Unauthorized' });
                    ws.close(4401, (auth.error || 'Unauthorized').substring(0, 120));
                });
                return;
            }

            const { user, sessionId } = auth;
            if (!sessionId) {
                console.warn('[WS Upgrade] Rejected: Missing sessionId');
                wss.handleUpgrade(request, socket, head, (ws) => {
                    safeSend(ws, { type: 'ERROR', message: 'Missing sessionId parameter' });
                    ws.close(4400, 'Missing sessionId');
                });
                return;
            }

            const session = await validateSessionAccess(user.id, sessionId);
            if (!session) {
                console.warn(`[WS Upgrade] Rejected: Session ${sessionId} not found or unauthorized for user ${user.id}`);
                wss.handleUpgrade(request, socket, head, (ws) => {
                    safeSend(ws, { type: 'ERROR', message: 'Session not found or not owned by your account' });
                    ws.close(4404, 'Session not found or not owned by your account');
                });
                return;
            }

            if (session.status !== 'LIVE') {
                console.log(`[WS Upgrade] Session ${sessionId} was ${session.status}, re-opening to LIVE`);
                await prisma.lectureSession.update({
                    where: { id: session.id },
                    data: { status: 'LIVE' }
                });
            }

            // Stop any existing session handler in background without blocking this handshake
            const prevSession = liveSessions.get(session.id);
            if (prevSession) {
                liveSessions.delete(session.id);
                prevSession.stop().catch(err => console.error('[WS] Previous session cleanup notice:', err.message));
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request, user, session);
            });
        } catch (err) {
            console.error('[WS Upgrade] Error during upgrade:', err);
            try {
                if (socket.writable) {
                    socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
                }
            } catch {}
            try { socket.destroy(); } catch {}
        }
    });

    wss.on('connection', (clientWs, request, user, session) => {
        const sessionId = session.id;
        console.log(`[WS] User ${user.id} (${user.email}) connected to session ${sessionId}`);

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
            if (notes.length > 0) {
                safeSend(clientWs, { type: 'NOTE_BLOCKS_UPDATED', blocks: notes });
            }
            if (transcripts.length > 0) {
                safeSend(clientWs, { type: 'RECENT_TRANSCRIPTS', chunks: transcripts });
            }
        }).catch((err) => console.error('Initial session data error:', err.message));

        let stopping = null;
        const stop = () => (stopping ??= (async () => {
            try {
                await transcription.close();
                await stopNoteWorker();
            } catch (err) {
                console.error(`Error stopping session ${sessionId}:`, err.message);
            } finally {
                liveSessions.delete(sessionId);
                if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
            }
        })());
        liveSessions.set(sessionId, { stop });

        transcription.initialize().catch((err) => {
            console.error('Transcription init notice:', err.message);
            // Keep clientWs connected so speech recognition and text ingestion continue smoothly
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
                    safeSend(clientWs, { type: 'QA_ERROR', error: 'Failed to answer question.' });
                });
            }
        });

        clientWs.on('close', (code, reason) => {
            console.log(`[WS] Client disconnected from session ${sessionId} (code ${code})`);
            stop();
        });
    });
}
