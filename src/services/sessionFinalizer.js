import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { generateGeminiEmbedding } from '../lib/gemini.js';
import { transcriptStreamKey } from './transcriptionService.js';

// The session is already PROCESSING (claimed by endSession) and the live pipeline is stopped.
export async function finalizeLectureSession(sessionId) {
    try {
        // 1. Fetch all chunks needing embedding generation/refresh
        const chunksToEmbed = await prisma.noteChunk.findMany({
            where: {
                sessionId,
                OR: [
                    { embeddingVersion: 0 },
                    { embeddingVersion: { lt: prisma.noteChunk.fields.version } }
                ]
            }
        });

        for (const chunk of chunksToEmbed) {
            const vector = await generateGeminiEmbedding(`${chunk.heading}\n${chunk.content}`);

            // Raw SQL to write into the pgvector column
            await prisma.$executeRaw`
                UPDATE "NoteChunk"
                SET
                    embedding = ${JSON.stringify(vector)}::vector,
                    "embeddingVersion" = version,
                    "updatedAt" = NOW()
                WHERE id = ${chunk.id};
            `;
        }

        await redis.del(transcriptStreamKey(sessionId));

        // 2. Mark Session COMPLETED
        return await prisma.lectureSession.update({
            where: { id: sessionId },
            data: { status: 'COMPLETED', endedAt: new Date() }
        });
    } catch (err) {
        await prisma.lectureSession.update({
            where: { id: sessionId },
            data: { status: 'FAILED' }
        });
        throw err;
    }
}
