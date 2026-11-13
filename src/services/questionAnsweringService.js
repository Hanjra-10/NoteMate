import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { generateGeminiEmbedding, answerQueryWithContextStream } from '../lib/gemini.js';

export const NO_CONTEXT_MESSAGE =
    'No relevant information found in your current or previous lecture notes.';

/**
 * Builds the RAG context for a question.
 *  - Current session: read directly. Live notes are only embedded when the session is
 *    finalized, so a vector search would find nothing during the lecture.
 *  - Past sessions: vector search over COMPLETED sessions (same subject if given, else all
 *    of the user's subjects). Always scoped to the user.
 */
export async function retrieveContext({ userId, question, sessionId, subjectId }) {
    const currentChunks = sessionId
        ? await prisma.noteChunk.findMany({
            where: { sessionId },
            orderBy: { sortOrder: 'asc' },
            select: { heading: true, content: true }
        })
        : [];

    const queryVector = `[${(await generateGeminiEmbedding(question)).join(',')}]`;

    const historicalChunks = await prisma.$queryRaw(Prisma.sql`
        SELECT nc.heading, nc.content, ls.title AS "sessionTitle"
        FROM "NoteChunk" nc
        JOIN "LectureSession" ls ON nc."sessionId" = ls.id
        JOIN "Subject" s ON ls."subjectId" = s.id
        WHERE s."userId" = ${userId}
          ${subjectId ? Prisma.sql`AND s.id = ${subjectId}` : Prisma.empty}
          ${sessionId ? Prisma.sql`AND ls.id != ${sessionId}` : Prisma.empty}
          AND ls.status = 'COMPLETED'
          AND nc.embedding IS NOT NULL
          AND (1 - (nc.embedding <=> ${queryVector}::vector)) > 0.5
        ORDER BY nc.embedding <=> ${queryVector}::vector
        LIMIT 3;
    `);

    const context = [
        ...currentChunks.map(c => `[Current Lecture - ${c.heading}]: ${c.content}`),
        ...historicalChunks.map(c => `[Past Session "${c.sessionTitle}" - ${c.heading}]: ${c.content}`)
    ].join('\n\n---\n\n');

    return { currentChunks, historicalChunks, context };
}

// WebSocket flavour: streams the answer to the connected client
export async function answerStudentQuestion({ userId, sessionId, subjectId, question, clientWs }) {
    const send = (payload) => {
        if (clientWs.readyState === 1) clientWs.send(JSON.stringify(payload));
    };

    const { context } = await retrieveContext({ userId, question, sessionId, subjectId });

    if (!context) {
        send({ type: 'QA_ANSWER_CHUNK', text: NO_CONTEXT_MESSAGE });
    } else {
        for await (const text of answerQueryWithContextStream(context, question)) {
            send({ type: 'QA_ANSWER_CHUNK', text });
        }
    }

    send({ type: 'QA_ANSWER_END' });
}
