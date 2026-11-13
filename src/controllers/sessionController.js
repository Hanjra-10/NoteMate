import { prisma } from '../lib/prisma.js';
import { validateSessionAccess } from '../middleware/ownership.js';
import { endLiveSession } from '../services/websocketService.js';
import { finalizeLectureSession } from '../services/sessionFinalizer.js';

export async function getSessions(req, res) {
    const { subjectId } = req.params;

    const subject = await prisma.subject.findFirst({
        where: { id: subjectId, userId: req.user.id }
    });
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    const sessions = await prisma.lectureSession.findMany({
        where: { subjectId },
        orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, data: sessions });
}

// GET /api/sessions/:sessionId  -> session + its notes and transcript
export async function getSession(req, res) {
    const session = await prisma.lectureSession.findFirst({
        where: { id: req.params.sessionId, subject: { userId: req.user.id } },
        include: {
            noteChunks: { orderBy: { sortOrder: 'asc' } },
            transcriptChunks: { orderBy: { sequence: 'asc' } }
        }
    });
    if (!session) {
        return res.status(404).json({ error: 'Session not found or unauthorized' });
    }

    res.json({ success: true, data: session });
}

export async function createSession(req, res) {
    const { subjectId } = req.params;
    const { title } = req.body;

    const subject = await prisma.subject.findFirst({
        where: { id: subjectId, userId: req.user.id }
    });

    if (!subject) {
        return res.status(404).json({ error: 'Subject not found or unauthorized' });
    }

    const session = await prisma.lectureSession.create({
        data: {
            subjectId,
            title: title || `Lecture - ${new Date().toLocaleDateString()}`,
            status: 'LIVE'
        }
    });

    res.status(201).json({ success: true, data: session });
}

export async function endSession(req, res) {
    const { sessionId } = req.params;

    const session = await validateSessionAccess(req.user.id, sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found or unauthorized' });
    }

    const claimed = await prisma.lectureSession.updateMany({
        where: { id: sessionId, status: { in: ['LIVE', 'FAILED'] } },
        data: { status: 'PROCESSING' }
    });
    if (claimed.count === 0) {
        return res.status(409).json({ error: `Session is already ${session.status.toLowerCase()}` });
    }

    endLiveSession(sessionId)
        .then(() => finalizeLectureSession(sessionId))
        .catch((err) => console.error(`Finalization error for session ${sessionId}:`, err));

    res.json({ success: true, message: 'Session ending; notes are being finalized and embedded' });
}
