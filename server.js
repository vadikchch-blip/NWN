/**
 * NWN Education Server
 * - Secure audio/video/image streaming from Cloudflare R2
 * - Authentication with JWT (login/password)
 * - Role-based page access (admin, seller, trainee, candidate)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'nwn-secret-key-change-in-production-2026';

// ── Database ──
// Prefer public URL over internal (Railway auto-injects internal DATABASE_URL which may not resolve)
const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl ? { rejectUnauthorized: false } : false
});

// ── Middleware ──
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ── Auth helpers ──
function generateToken(user) {
    return jwt.sign({ id: user.id, username: user.username, role_id: user.role_id }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

// Extract token from cookie or Authorization header
function getToken(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    if (req.cookies && req.cookies.nwn_token) return req.cookies.nwn_token;
    // Parse cookie manually
    const cookie = req.headers.cookie;
    if (cookie) {
        const match = cookie.match(/nwn_token=([^;]+)/);
        if (match) return match[1];
    }
    return null;
}

// ── Page access map (file → page slug) ──
const FILE_TO_SLUG = {
    '/index.html': 'archetypes',
    '/sales.html': 'sales',
    '/di.html': 'di',
    '/reglament.html': 'reglament',
    '/checklists.html': 'checklists',
    '/brands.html': 'brands',
    '/tech.html': 'tech',
    '/methodology.html': 'methodology'
};

// Pages that don't require auth
const PUBLIC_PAGES = ['/login.html', '/register.html', '/install.html', '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png', '/qr-install.svg', '/nwn-logo.png', '/health', '/favicon.ico'];

// ── Auth middleware for protected pages ──
async function authMiddleware(req, res, next) {
    const urlPath = req.path;

    // Allow public assets
    if (PUBLIC_PAGES.includes(urlPath) || urlPath.startsWith('/api/auth/')) {
        return next();
    }

    // Allow API endpoints (audio-url etc) — they have their own logic
    if (urlPath === '/audio-url' || urlPath === '/health') {
        return next();
    }

    // Check if this is a protected page
    const slug = FILE_TO_SLUG[urlPath];
    if (!slug) {
        return next(); // Not a protected page (CSS, JS, fonts etc.)
    }

    // Check auth token
    const token = getToken(req);
    if (!token) {
        return res.redirect('/login.html');
    }

    const user = verifyToken(token);
    if (!user) {
        return res.redirect('/login.html');
    }

    // Check page access
    try {
        const result = await pool.query(
            `SELECT pa.has_access FROM page_access pa
             JOIN pages p ON p.id = pa.page_id
             WHERE pa.role_id = $1 AND p.slug = $2`,
            [user.role_id, slug]
        );

        if (result.rows.length === 0 || !result.rows[0].has_access) {
            return res.status(403).send(`
                <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Нет доступа</title>
                <style>body{font-family:Inter,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;color:#1a1a1a}
                .box{text-align:center;max-width:360px;padding:40px}.h{font-size:20px;font-weight:500;margin-bottom:12px}.p{font-size:14px;color:#888;line-height:1.6;margin-bottom:24px}
                a{font-size:13px;color:#1a1a1a;text-decoration:underline}</style></head>
                <body><div class="box"><div class="h">Нет доступа</div><div class="p">У вашей роли нет доступа к этой странице. Обратитесь к администратору.</div><a href="/methodology.html">На главную</a></div></body></html>
            `);
        }
    } catch (err) {
        console.error('Access check error:', err.message);
    }

    next();
}

// Apply auth middleware BEFORE static files
app.use(authMiddleware);

// Serve static files
app.use(express.static(path.join(__dirname)));

// ── Cloudflare R2 ──
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'podcasts';
const URL_EXPIRATION_SECONDS = parseInt(process.env.URL_EXPIRATION_SECONDS) || 600;

let s3Client = null;
function initializeR2Client() {
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        console.warn('R2 credentials not configured');
        return null;
    }
    return new S3Client({ region: 'auto', endpoint: R2_ENDPOINT, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });
}
s3Client = initializeR2Client();

const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.mp4', '.MP4', '.mov', '.jpg', '.jpeg', '.png', '.webp', '.gif'];

function isValidFilename(filename) {
    if (!filename || typeof filename !== 'string') return false;
    if (filename.includes('..') || filename.includes('\\')) return false;
    const ext = path.extname(filename).toLowerCase();
    return ALLOWED_EXTENSIONS.includes(ext);
}

function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = { '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.webm':'audio/webm','.mp4':'video/mp4','.mov':'video/quicktime','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif' };
    return types[ext] || 'application/octet-stream';
}

// ── R2 signed URL endpoint ──
app.get('/audio-url', async (req, res) => {
    try {
        const { filename } = req.query;
        if (!filename) return res.status(400).json({ error: 'Missing filename' });
        if (!isValidFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
        if (!s3Client) return res.status(503).json({ error: 'Storage not configured' });

        const ALLOWED_BUCKETS = [R2_BUCKET_NAME, 'nwn-storage'];
        const bucket = req.query.bucket && ALLOWED_BUCKETS.includes(req.query.bucket) ? req.query.bucket : R2_BUCKET_NAME;

        const command = new GetObjectCommand({ Bucket: bucket, Key: filename, ResponseContentDisposition: 'inline', ResponseContentType: getContentType(filename) });
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: URL_EXPIRATION_SECONDS });
        res.json({ success: true, url: signedUrl, expiresIn: URL_EXPIRATION_SECONDS, filename });
    } catch (error) {
        console.error('R2 error:', error.message);
        if (error.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ══════════════════════════════════
// ── AUTH API ──
// ══════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, display_name } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
        if (username.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
        if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

        const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'Этот логин уже занят' });

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password, display_name, role_id) VALUES ($1, $2, $3, 4) RETURNING id, username, role_id',
            [username.toLowerCase(), hash, display_name || username]
        );

        const user = result.rows[0];
        const token = generateToken(user);
        res.json({ success: true, token, user: { id: user.id, username: user.username, role_id: user.role_id } });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Ошибка регистрации' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });

        const result = await pool.query(
            `SELECT u.*, r.name as role_name, r.label as role_label FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = $1 AND u.is_active = true`,
            [username.toLowerCase()]
        );

        if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const token = generateToken(user);
        res.json({ success: true, token, user: { id: user.id, username: user.username, display_name: user.display_name, role_id: user.role_id, role_name: user.role_name, role_label: user.role_label } });
    } catch (err) {
        console.error('Login error:', err.message, err.stack);
        res.status(500).json({ error: 'Ошибка входа: ' + err.message });
    }
});

// Get current user info + accessible pages
app.get('/api/auth/me', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid token' });

    try {
        const userResult = await pool.query(
            `SELECT u.id, u.username, u.display_name, u.role_id, r.name as role_name, r.label as role_label
             FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.is_active = true`, [decoded.id]
        );
        if (userResult.rows.length === 0) return res.status(401).json({ error: 'User not found' });

        const user = userResult.rows[0];
        const pagesResult = await pool.query(
            `SELECT p.slug, p.title, p.file_path, pa.has_access
             FROM page_access pa JOIN pages p ON p.id = pa.page_id
             WHERE pa.role_id = $1 ORDER BY p.id`, [user.role_id]
        );

        res.json({ user, pages: pagesResult.rows });
    } catch (err) {
        console.error('Me error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ══════════════════════════════════
// ── ADMIN API ──
// ══════════════════════════════════

// Admin middleware
async function requireAdmin(req, res, next) {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = verifyToken(token);
    if (!decoded || decoded.role_id !== 1) return res.status(403).json({ error: 'Admin only' });
    next();
}

// List all users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id, u.username, u.password, u.display_name, u.role_id, u.is_active, u.created_at, r.label as role_label
             FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update user role
app.put('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
    try {
        const { role_id } = req.body;
        if (![1,2,3,4].includes(role_id)) return res.status(400).json({ error: 'Invalid role' });
        await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [role_id, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle user active status
app.put('/api/admin/users/:id/toggle', requireAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete user
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1 AND role_id != 1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all roles
app.get('/api/admin/roles', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roles ORDER BY id');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get page access matrix
app.get('/api/admin/access', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT pa.role_id, pa.page_id, pa.has_access, p.slug, p.title, r.label as role_label
             FROM page_access pa JOIN pages p ON p.id = pa.page_id JOIN roles r ON r.id = pa.role_id
             ORDER BY pa.role_id, pa.page_id`
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update page access
app.put('/api/admin/access', requireAdmin, async (req, res) => {
    try {
        const { role_id, page_id, has_access } = req.body;
        await pool.query(
            'UPDATE page_access SET has_access = $3 WHERE role_id = $1 AND page_id = $2',
            [role_id, page_id, has_access]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health check ──
app.get('/health', (req, res) => {
    res.json({ status: 'ok', r2Configured: !!s3Client, dbConfigured: !!process.env.DATABASE_URL || !!process.env.DATABASE_PUBLIC_URL });
});

// ── Start ──
app.listen(PORT, () => {
    console.log(`\nNWN Education Server`);
    console.log(`Port: ${PORT}`);
    console.log(`R2: ${s3Client ? 'OK' : 'Not configured'}`);
    console.log(`DB: ${pool ? 'Connected' : 'Not configured'}`);
    console.log(`Auth: Enabled\n`);
});
