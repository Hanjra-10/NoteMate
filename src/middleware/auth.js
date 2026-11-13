import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'notemate-production-jwt-secret-fallback-key';

export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Unauthorised : Missing tokens" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Forbidden : Invalid or expired token" });
        req.user = user;
        next();
    });
}

export function parseWsAuth(req) {
    let token = null;
    let sessionId = null;

    try {
        const host = req.headers['host'] || 'localhost';
        const url = new URL(req.url, `http://${host}`);
        token = url.searchParams.get('token');
        sessionId = url.searchParams.get('sessionId');
    } catch {
        const query = (req.url || '').split('?')[1] || '';
        const params = new URLSearchParams(query);
        token = params.get('token');
        sessionId = params.get('sessionId');
    }

    if (!token) {
        return { error: 'Missing token in connection request', sessionId };
    }

    try {
        const user = jwt.verify(token, JWT_SECRET);
        return { user, sessionId, token };
    } catch (err) {
        return { error: `Authentication failed: ${err.message}`, sessionId };
    }
}

export function authenticateWs(req) {
    const result = parseWsAuth(req);
    return result.user || null;
}
