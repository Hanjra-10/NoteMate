
import { handleQuery } from './src/controllers/queryController.js';

// Mock Express request
const req = {
    body: {
        question: "Explain Newton's three laws of motion",
    },
    user: {
        id: "12e267af-4ea3-4751-bb14-ff6610095223"
    }
};

// Mock Express response
const res = {
    statusCode: 200,

    status(code) {
        this.statusCode = code;
        return this;
    },

    json(data) {
        console.log('\nHTTP Status:', this.statusCode);
        console.log('Response:', JSON.stringify(data, null, 2));
        return this;
    }
};

// Execute controller
console.time('handleQuery');

try {
    await handleQuery(req, res);
} catch (error) {
    console.error('Test failed:', error);
}

console.timeEnd('handleQuery');
