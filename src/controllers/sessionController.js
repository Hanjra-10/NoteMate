import { prisma } from '../lib/prisma.js';
import { validateSessionAccess } from '../middleware/ownership.js';
import { endLiveSession } from '../services/websocketService.js';
import { finalizeLectureSession } from '../services/sessionFinalizer.js';
import { ai, MODEL_NAME } from '../lib/gemini.js';
import { Type } from '@google/genai';

const studyMaterialsSchema = {
    type: Type.OBJECT,
    properties: {
        quiz: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    question: { type: Type.STRING },
                    options: { type: Type.ARRAY, items: { type: Type.STRING } },
                    correctIndex: { type: Type.INTEGER },
                    explanation: { type: Type.STRING }
                },
                required: ['question', 'options', 'correctIndex', 'explanation']
            }
        },
        flashcards: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    front: { type: Type.STRING },
                    back: { type: Type.STRING }
                },
                required: ['front', 'back']
            }
        }
    },
    required: ['quiz', 'flashcards']
};

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

export async function updateNoteChunk(req, res) {
    const { noteId } = req.params;
    const { heading, content } = req.body;

    const note = await prisma.noteChunk.findFirst({
        where: { id: noteId, session: { subject: { userId: req.user.id } } }
    });
    if (!note) return res.status(404).json({ error: 'Note block not found or unauthorized' });

    const updated = await prisma.noteChunk.update({
        where: { id: noteId },
        data: {
            heading: heading !== undefined ? heading : note.heading,
            content: content !== undefined ? content : note.content,
            version: { increment: 1 }
        }
    });
    res.json({ success: true, data: updated });
}

export async function generateQuizAndFlashcards(req, res) {
    const { sessionId } = req.params;
    const session = await validateSessionAccess(req.user.id, sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or unauthorized' });

    const notes = await prisma.noteChunk.findMany({
        where: { sessionId },
        orderBy: { sortOrder: 'asc' }
    });

    let sourceText = notes.map(n => `### ${n.heading}\n${n.content}`).join('\n\n');

    if (!sourceText.trim()) {
        const transcripts = await prisma.transcriptChunk.findMany({
            where: { sessionId },
            orderBy: { sequence: 'asc' }
        });
        sourceText = transcripts.map(t => t.text).join(' ');
    }

    if (!sourceText.trim()) {
        return res.status(400).json({ error: 'No lecture notes or transcripts available to generate quiz from.' });
    }

    try {
        const response = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: `Generate a study quiz (4-5 multiple choice questions) and flashcard deck (5 key terms/concepts) from the following lecture content:\n\n${sourceText}`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: studyMaterialsSchema,
                temperature: 0.3
            }
        });

        const data = JSON.parse(response.text);
        res.json({ success: true, data });
    } catch (err) {
        console.error('Quiz generation error:', err);
        res.status(500).json({ error: 'Failed to generate quiz and flashcards.' });
    }
}
