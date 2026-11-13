import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import { login, register } from './controllers/authcontroller.js';
import { initWebSocketServer } from './services/websocketService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

// Static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: "healthy", message: "APIs running health" });
});

// Authentication Routes (public)
app.post('/api/auth/register', register);
app.post('/api/auth/login', login);

// Protected API: subjects, sessions, query
app.use('/api', apiRouter);

// Fallback to Web UI for client routes
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

const server = http.createServer(app);

// Attach WebSocket Handling
initWebSocketServer(server);

const PORT = process.env.PORT || 8080;
if (!process.env.VERCEL) {
    server.listen(PORT, () => {
        console.log(`Backend Server running on port ${PORT}`);
    });
}

export default app;
