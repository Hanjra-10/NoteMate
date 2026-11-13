import { validateSessionAccess } from '../middleware/ownership.js';
import { answerQueryWithContextStream } from '../lib/gemini.js';
import { retrieveContext, NO_CONTEXT_MESSAGE } from '../services/questionAnsweringService.js';

export async function handleQuery(req, res) {
    const { question, sessionId, subjectId } = req.body ?? {};
    const userId = req.user.id;

    try {
        if (!question || typeof question !== 'string' || !question.trim()) {
            return res.status(400).json({ error: 'Question is required.' });
        }

        let resolvedSubjectId = subjectId;
        if (sessionId) {
            const session = await validateSessionAccess(userId, sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Session not found or unauthorized' });
            }
            resolvedSubjectId = session.subjectId;
        }

        const { currentChunks, historicalChunks, context } = await retrieveContext({
            userId,
            question,
            sessionId,
            subjectId: resolvedSubjectId
        });

        const retrievedChunks = {
            currentSession: currentChunks.length,
            previousSessions: historicalChunks.length,
            total: currentChunks.length + historicalChunks.length
        };

        if (!context) {
            return res.json({ answer: NO_CONTEXT_MESSAGE, retrievedChunks });
        }

        let answer = '';
        for await (const text of answerQueryWithContextStream(context, question)) {
            answer += text;
        }

        return res.json({ answer, retrievedChunks });
    } catch (error) {
        console.error('RAG Query Error:', error);
        return res.status(500).json({ error: 'Failed to process lecture question.' });
    }
}
