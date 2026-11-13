import jwt from 'jsonwebtoken';

export function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Unauthorised : Missing tokens" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Forbidden : Invalid token" });
        req.user = user;
        next();
    });
}
export function authenticateWs(req) {
    const host = req.headers['host'] || 'localhost';
    const url = new URL(req.url, `http://${host}`);
    const token = url.searchParams.get('token');
    if (!token) return null;
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        console.warn('WS auth verify error:', err.message);
        return null;
    }
}