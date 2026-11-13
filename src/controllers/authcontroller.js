import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
    return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

export async function register(req, res) {
    const { email, password, name } = req.body ?? {};

    if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
        return res.status(400).json({ error: 'A valid email is required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email: email.trim().toLowerCase(),
                password: hashedPassword,
                name: name.trim(),
            },
        });

        return res.status(201).json({
            token: signToken(user),
            user: { id: user.id, email: user.email, name: user.name },
        });
    } catch (err) {
        if (err.code === 'P2002') {
            return res.status(409).json({ error: 'Email already registered' });
        }
        console.error('Register error:', err);
        return res.status(500).json({ error: 'Registration failed' });
    }
}

export async function login(req, res) {
    const { email, password } = req.body ?? {};

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: email.trim().toLowerCase() },
        });

        const valid = user && (await bcrypt.compare(password, user.password));
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        return res.json({
            token: signToken(user),
            user: { id: user.id, email: user.email, name: user.name },
        });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Login failed' });
    }
}