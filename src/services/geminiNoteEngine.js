import { Type, ThinkingLevel } from '@google/genai';
import { prisma } from '../lib/prisma.js';
import { ai, MODEL_NAME } from '../lib/gemini.js';

const noteOperationsSchema = {
    type: Type.ARRAY,
    description: 'Operations to maintain lecture notes incrementally.',
    items: {
        type: Type.OBJECT,
        properties: {
            action: { type: Type.STRING, enum: ['CREATE', 'UPDATE', 'IGNORE'] },
            noteChunkId: { type: Type.STRING, description: 'Existing block ID if UPDATE, omit if CREATE' },
            heading: { type: Type.STRING },
            content: { type: Type.STRING, description: 'Markdown text for the note block' },
            sortOrder: { type: Type.INTEGER }
        },
        required: ['action', 'heading', 'content']
    }
};

export async function generateIncrementalNotes(sessionId, newTranscriptText) {
    // 1. Load the existing note blocks for this session
    const existingChunks = await prisma.noteChunk.findMany({
        where: { sessionId },
        select: { id: true, heading: true, content: true, sortOrder: true, version: true },
        orderBy: { sortOrder: 'asc' }
    });

    // Full content is required: UPDATE replaces the block, so Gemini must see what it is preserving
    const outline = existingChunks.map(c => ({
        id: c.id,
        heading: c.heading,
        content: c.content,
        sortOrder: c.sortOrder
    }));

    const prompt = `
You are an academic lecture note generator. Update structured Markdown notes for a live lecture session based on incoming transcripts.

CURRENT NOTE BLOCKS:
${JSON.stringify(outline, null, 2)}

NEW TRANSCRIPT BATCH:
"${newTranscriptText}"

INSTRUCTIONS:
1. Review the new transcript batch.
2. Decide whether to:
   - "CREATE": Summarize new topics or key concepts as a new note block with an informative heading and detailed Markdown bullet points.
   - "UPDATE": Rewrite an existing block identified by its noteChunkId. Return its COMPLETE new content: preserve all previously written information and integrate the new insights cleanly.
   - "IGNORE": Only use IGNORE if the text is pure noise or completely devoid of substantive words. If the speaker is explaining any concept, always capture it.
3. Write clean, professional structured academic Markdown. Include bold key terms, definitions, and concise bullet points.
4. Return ONLY structured operations matching the required JSON schema.
`;

    const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
            responseMimeType: 'application/json',
            responseSchema: noteOperationsSchema,
            temperature: 0.2,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } // 3.5 Flash defaults to MEDIUM; this is a mechanical merge task
        }
    });
    const operations = JSON.parse(response.text);

    // 2. Apply all operations atomically so a failed batch can be retried without duplicating blocks
    return prisma.$transaction(async (tx) => {
        const changedBlocks = [];
        let nextOrder = Math.max(0, ...existingChunks.map(c => c.sortOrder)) + 1;

        for (const op of operations) {
            if (op.action === 'CREATE') {
                const created = await tx.noteChunk.create({
                    data: {
                        sessionId,
                        heading: op.heading,
                        content: op.content,
                        sortOrder: op.sortOrder ?? nextOrder++,
                        version: 1,
                        embeddingVersion: 0
                    }
                });
                changedBlocks.push(created);
            } else if (op.action === 'UPDATE' && op.noteChunkId) {
                const target = existingChunks.find(e => e.id === op.noteChunkId);
                if (!target) continue;

                // Version check guards against concurrent writers
                const updated = await tx.noteChunk.update({
                    where: { id: target.id, version: target.version },
                    data: {
                        heading: op.heading,
                        content: op.content,
                        version: { increment: 1 }
                    }
                });
                target.version = updated.version; // keep in sync if the same block is updated twice in one batch
                changedBlocks.push(updated);
            }
        }

        return changedBlocks;
    });
}
