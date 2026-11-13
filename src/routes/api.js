import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getSubjects, createSubject, deleteSubject } from '../controllers/subjectController.js';
import { createSession, endSession, updateNoteChunk, generateQuizAndFlashcards } from '../controllers/sessionController.js';
import { handleQuery } from '../controllers/queryController.js';
import { getSessions, getSession } from '../controllers/sessionController.js';
const router = Router();

router.use(authenticateToken);

// Subject Routes
router.get('/subjects', getSubjects);
router.post('/subjects', createSubject);
router.delete('/subjects/:subjectId', deleteSubject);

// Session Routes
router.post('/subjects/:subjectId/sessions', createSession);
router.get('/sessions/:sessionId', getSession);
router.post('/sessions/:sessionId/end', endSession);
router.get('/subjects/:subjectId/sessions', getSessions);

// Note Editing & AI Study Materials
router.patch('/notes/:noteId', updateNoteChunk);
router.post('/sessions/:sessionId/quiz', generateQuizAndFlashcards);

// RAG Query Endpoint
router.post('/query', handleQuery);

export default router;
