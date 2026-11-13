import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
export const MODEL_NAME = 'gemini-3.1-flash-lite';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768; // must match vector(768) in schema.prisma

export async function generateGeminiEmbedding(text) {
    const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    return response.embeddings[0].values;
}

function buildAnswerPrompt(context, question) {
    return `
You are NoteMate AI assistant. Answer the student's question accurately based on the provided current and historical context.

CONTEXT:
${context}

STUDENT QUESTION:
"${question}"

Provide a clear, formatted explanation. Distinctly clarify if a reference comes from previous sessions vs. the current lecture.
`;
}

export async function* answerQueryWithContextStream(context, question) {
    const responseStream = await ai.models.generateContentStream({
        model: MODEL_NAME,
        contents: buildAnswerPrompt(context, question),
    });

    for await (const chunk of responseStream) {
        if (chunk.text) yield chunk.text;
    }
}
