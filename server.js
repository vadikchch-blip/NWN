/**
 * NWN Education Server
 * - Secure audio/video/image streaming from Cloudflare R2
 * - Authentication with JWT (login/password)
 * - Role-based page access (admin, seller, trainee, candidate)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs');
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
const PUBLIC_PAGES = ['/login.html', '/register.html', '/install.html', '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png', '/qr-install.svg', '/nwn-logo.png', '/health', '/favicon.ico', '/access/supreme-first-access', '/access/supreme'];

// First Access config
const MAX_ACTIVE_RESERVATIONS_PER_INVITE = parseInt(process.env.MAX_ACTIVE_RESERVATIONS_PER_INVITE) || 5;
const RESERVATION_TTL_HOURS = parseInt(process.env.RESERVATION_TTL_HOURS) || 24;
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || 'https://pub-fa833a523d7b4426930443e4050356ce.r2.dev').replace(/\/$/, '');
const R2_FIRST_ACCESS_PATH = process.env.R2_FIRST_ACCESS_PATH || 'Supreme';
const R2_FIRST_ACCESS_EXT = (process.env.R2_FIRST_ACCESS_EXT || '.webp').replace(/^\.?/, '.'); // ensure leading dot

let _imageKeyOverrides = null;
function getImageKeyOverrides() {
    if (_imageKeyOverrides !== null) return _imageKeyOverrides;
    const p = path.join(__dirname, 'data', 'image_key_overrides.json');
    try {
        if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (typeof data === 'object' && !Array.isArray(data)) {
                _imageKeyOverrides = {};
                for (const [k, v] of Object.entries(data)) {
                    if (!k.startsWith('_') && typeof v === 'string') _imageKeyOverrides[k] = v;
                }
                return _imageKeyOverrides;
            }
        }
    } catch (e) {}
    _imageKeyOverrides = {};
    return _imageKeyOverrides;
}

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

// Favicon fallback
app.get('/favicon.ico', (req, res) => res.redirect(301, '/icon-192.png'));

// ── First Access page (token-based, no JWT) ──
function sendFirstAccessHtml(res, htmlPath) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(htmlPath);
}
app.get('/access/supreme-first-access', (req, res) => {
    const htmlPath = path.join(__dirname, 'access', 'supreme-first-access.html');
    if (fs.existsSync(htmlPath)) {
        sendFirstAccessHtml(res, htmlPath);
    } else {
        res.status(404).send('Page not found');
    }
});
app.get('/access/supreme', (req, res) => {
    const htmlPath = path.join(__dirname, 'access', 'supreme-first-access.html');
    if (fs.existsSync(htmlPath)) {
        sendFirstAccessHtml(res, htmlPath);
    } else {
        res.status(404).send('Page not found');
    }
});
app.get('/access/supreme-first-access.html', (req, res) => {
    const htmlPath = path.join(__dirname, 'access', 'supreme-first-access.html');
    if (fs.existsSync(htmlPath)) {
        sendFirstAccessHtml(res, htmlPath);
    } else {
        res.status(404).send('Page not found');
    }
});

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

// ── First Access Admin (invites list + reservations) ──
function getBaseUrl(req) {
    const base = process.env.BASE_URL || process.env.APP_URL;
    if (base) return base.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host') || ''}`;
}

app.get('/api/first-access/admin/invites', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, full_name, token, access_starts_at, access_ends_at, is_active, created_at
             FROM first_access_invites ORDER BY created_at DESC`
        );
        const baseUrl = getBaseUrl(req);
        const rows = result.rows.map(r => ({
            ...r,
            invite_url: `${baseUrl}/access/supreme-first-access.html?token=${encodeURIComponent(r.token)}`
        }));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/first-access/admin/reservations', requireAdmin, async (req, res) => {
    try {
        const statusFilter = req.query.status;
        const baseQuery = `
            SELECT r.id, r.size, r.status, r.reserved_at, r.expires_at,
                   i.full_name AS guest_name,
                   p.title AS product_title, p.article AS product_article, p.brand
            FROM first_access_reservations r
            JOIN first_access_invites i ON i.id = r.invite_id
            JOIN first_access_products p ON p.id = r.product_id`;
        const where = statusFilter ? ' WHERE r.status = $1' : '';
        const order = ' ORDER BY r.reserved_at DESC';
        const result = await pool.query(baseQuery + where + order, statusFilter ? [statusFilter] : []);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════
// ── FIRST ACCESS (Supreme) API ──
// ══════════════════════════════════

function getFirstAccessToken(req) {
    return req.query?.token || req.body?.token || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
}

async function validateInviteToken(token) {
    if (!token) return { ok: false, status: 403, error: 'Токен не указан' };
    const r = await pool.query(
        `SELECT id, full_name, access_starts_at, access_ends_at, is_active
         FROM first_access_invites WHERE token = $1`,
        [token]
    );
    if (r.rows.length === 0) return { ok: false, status: 403, error: 'Доступ недоступен' };
    const inv = r.rows[0];
    if (!inv.is_active) return { ok: false, status: 403, error: 'Доступ отключён' };
    const now = new Date();
    if (now < inv.access_starts_at) return { ok: false, status: 403, error: 'Доступ ещё не начался' };
    if (now > inv.access_ends_at) return { ok: false, status: 410, error: 'Окно доступа завершено' };
    return { ok: true, invite: inv };
}

function normalizeImageKeyForR2(key) {
    if (!key || typeof key !== 'string') return key;
    return key.replace(/\sL\/S\s/g, ' L:S ').replace(/\sS\/S\s/g, ' S:S ').replace(/[×х]/g, 'x');
}
function buildImageUrl(imageKey, ext) {
    if (!imageKey || typeof imageKey !== 'string') return null;
    const key = normalizeImageKeyForR2(imageKey);
    const prefix = R2_FIRST_ACCESS_PATH ? `${R2_FIRST_ACCESS_PATH}/` : '';
    const e = (ext || R2_FIRST_ACCESS_EXT).replace(/^\.?/, '.');
    return `${R2_PUBLIC_BASE_URL}/${prefix}${encodeURIComponent(key)}${e}`;
}
// Ключи, для которых в R2 лежит только .jpeg (сначала отдаём .jpeg, чтобы фото гарантированно загрузилось)
const IMAGE_KEYS_JPEG_ONLY = [
    'SUPREME Сумка (FW25B16) Denim Mini Utility Bag White',
    'SUPREME Сумка (FW25B10) Velvet Mini Pouch Leopard'
];
function buildImageUrls(imageKey) {
    const jpegFirst = IMAGE_KEYS_JPEG_ONLY.some(k => k === (imageKey || '').trim());
    const primary = jpegFirst ? buildImageUrl(imageKey, '.jpeg') : buildImageUrl(imageKey);
    if (!primary) return [null, null];
    const rest = jpegFirst
        ? [buildImageUrl(imageKey), buildImageUrl(imageKey, '.jpg'), buildImageUrl(imageKey + ' OS размер'), buildImageUrl(imageKey + ' One Size'), buildImageUrl(imageKey + ' OS размер', '.jpeg')]
        : [buildImageUrl(imageKey, '.jpeg'), buildImageUrl(imageKey, '.jpg'), buildImageUrl(imageKey + ' OS размер'), buildImageUrl(imageKey + ' One Size'), buildImageUrl(imageKey + ' OS размер', '.jpeg')];
    return [primary, ...rest];
}

// GET /api/first-access/supreme/me
app.get('/api/first-access/supreme/me', async (req, res) => {
    const token = getFirstAccessToken(req);
    const v = await validateInviteToken(token);
    if (!v.ok) return res.status(v.status).json({ error: v.error });

    const countResult = await pool.query(
        `SELECT COUNT(*)::int as c FROM first_access_reservations
         WHERE invite_id = $1 AND status = 'active'`,
        [v.invite.id]
    );
    const activeReservationsCount = countResult.rows[0]?.c || 0;

    res.json({
        full_name: v.invite.full_name,
        access_ends_at: v.invite.access_ends_at,
        active_reservations_count: activeReservationsCount,
        max_allowed: MAX_ACTIVE_RESERVATIONS_PER_INVITE
    });
});

// GET /api/first-access/supreme/catalog
app.get('/api/first-access/supreme/catalog', async (req, res) => {
    const token = getFirstAccessToken(req);
    const v = await validateInviteToken(token);
    if (!v.ok) return res.status(v.status).json({ error: v.error });

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    try {
        const products = await pool.query(
            `SELECT p.id as product_id, p.article, p.title, p.price_rrc, p.image_key
             FROM first_access_products p
             WHERE p.is_active = true
             ORDER BY (CASE WHEN p.title ILIKE '%кубик%' OR p.title ILIKE '%игральн%' THEN 1 ELSE 0 END), p.title`
        );

        const catalog = [];
        for (const prod of products.rows) {
            const sizes = await pool.query(
                `SELECT ps.size, ps.qty_total,
                 COALESCE((SELECT SUM(r.qty)::int FROM first_access_reservations r
                   WHERE r.product_id = ps.product_id AND r.size = ps.size AND r.status = 'active'), 0) as qty_reserved
                 FROM first_access_product_sizes ps
                 WHERE ps.product_id = $1`,
                [prod.product_id]
            );

            const sizeList = [];
            for (const s of sizes.rows) {
                const available = Math.max(0, s.qty_total - s.qty_reserved);
                let status = 'unavailable';
                let reserved_until = null;

                if (s.qty_total === 0) {
                    status = 'unavailable';
                } else if (available > 0) {
                    status = 'available';
                } else {
                    status = 'reserved';
                    const minExp = await pool.query(
                        `SELECT MIN(expires_at) as m FROM first_access_reservations
                         WHERE product_id = $1 AND size = $2 AND status = 'active'`,
                        [prod.product_id, s.size]
                    );
                    reserved_until = minExp.rows[0]?.m || null;
                }

                sizeList.push({ size: s.size, status, available, reserved_until });
            }

            const imageKey = (getImageKeyOverrides()[prod.title] || prod.image_key || prod.title || '').trim();
            const urls = buildImageUrls(imageKey);
            catalog.push({
                product_id: prod.product_id,
                article: prod.article,
                title: prod.title,
                price_rrc: prod.price_rrc,
                image_url: urls[0],
                image_url_fallbacks: urls.slice(1).filter(Boolean),
                sizes: sizeList
            });
        }

        res.json(catalog);
    } catch (err) {
        console.error('Catalog error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/first-access/supreme/reserve
app.post('/api/first-access/supreme/reserve', async (req, res) => {
    const token = getFirstAccessToken(req);
    const v = await validateInviteToken(token);
    if (!v.ok) return res.status(v.status).json({ error: v.error });

    const { product_id, size } = req.body || {};
    if (!product_id || !size) return res.status(400).json({ error: 'Укажите product_id и size' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const countResult = await client.query(
            `SELECT COUNT(*)::int as c FROM first_access_reservations
             WHERE invite_id = $1 AND status = 'active'`,
            [v.invite.id]
        );
        if (countResult.rows[0].c >= MAX_ACTIVE_RESERVATIONS_PER_INVITE) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Лимит резервов достигнут' });
        }

        const sizeRow = await client.query(
            `SELECT id, qty_total, qty_reserved FROM first_access_product_sizes
             WHERE product_id = $1 AND size = $2 FOR UPDATE`,
            [product_id, size]
        );
        if (sizeRow.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Размер не найден' });
        }

        const sz = sizeRow.rows[0];
        const available = sz.qty_total - sz.qty_reserved;
        if (available <= 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Размер уже зарезервирован' });
        }

        const fixedExpiresEnv = process.env.RESERVATION_FIXED_EXPIRES_AT || '2026-03-05T17:00:00.000Z'; // 05.03 20:00 МСК
let expiresAt = fixedExpiresEnv ? new Date(fixedExpiresEnv) : new Date(Date.now() + RESERVATION_TTL_HOURS * 60 * 60 * 1000);
if (Number.isNaN(expiresAt.getTime())) expiresAt = new Date(Date.now() + RESERVATION_TTL_HOURS * 60 * 60 * 1000);
        const ins = await client.query(
            `INSERT INTO first_access_reservations (invite_id, product_id, size, qty, status, reserved_at, expires_at)
             VALUES ($1, $2, $3, 1, 'active', now(), $4)
             RETURNING id, expires_at`,
            [v.invite.id, product_id, size, expiresAt]
        );
        const reservation = ins.rows[0];

        await client.query(
            `UPDATE first_access_product_sizes SET qty_reserved = qty_reserved + 1, updated_at = now()
             WHERE product_id = $1 AND size = $2`,
            [product_id, size]
        );

        await client.query('COMMIT');

        res.json({
            reservation: { id: reservation.id, expires_at: reservation.expires_at },
            size_status: { size, status: 'reserved', reserved_until: reservation.expires_at }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Вы уже зарезервировали этот размер' });
        }
        console.error('Reserve error:', err.message);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

// POST /api/first-access/supreme/cancel
app.post('/api/first-access/supreme/cancel', async (req, res) => {
    const token = getFirstAccessToken(req);
    const v = await validateInviteToken(token);
    if (!v.ok) return res.status(v.status).json({ error: v.error });

    const { reservation_id } = req.body || {};
    if (!reservation_id) return res.status(400).json({ error: 'Укажите reservation_id' });

    const client = await pool.connect();
    try {
        const r = await client.query(
            `SELECT id, product_id, size FROM first_access_reservations
             WHERE id = $1 AND invite_id = $2 AND status = 'active'`,
            [reservation_id, v.invite.id]
        );
        if (r.rows.length === 0) {
            return res.status(404).json({ error: 'Резерв не найден' });
        }

        const resv = r.rows[0];
        await client.query('BEGIN');

        await client.query(
            `UPDATE first_access_reservations SET status = 'cancelled', updated_at = now() WHERE id = $1`,
            [reservation_id]
        );
        await client.query(
            `UPDATE first_access_product_sizes SET qty_reserved = qty_reserved - 1, updated_at = now()
             WHERE product_id = $1 AND size = $2`,
            [resv.product_id, resv.size]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Cancel error:', err.message);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

// POST /api/first-access/supreme/mark-purchased (internal/admin)
app.post('/api/first-access/supreme/mark-purchased', async (req, res) => {
    const { reservation_id } = req.body || {};
    if (!reservation_id) return res.status(400).json({ error: 'Укажите reservation_id' });

    const client = await pool.connect();
    try {
        const r = await client.query(
            `SELECT id, invite_id, product_id, size, qty FROM first_access_reservations
             WHERE id = $1 AND status = 'active'`,
            [reservation_id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Резерв не найден' });

        const resv = r.rows[0];
        await client.query('BEGIN');

        await client.query(
            `UPDATE first_access_reservations SET status = 'purchased', updated_at = now() WHERE id = $1`,
            [reservation_id]
        );
        await client.query(
            `UPDATE first_access_product_sizes SET qty_total = qty_total - $1, qty_reserved = qty_reserved - $1, updated_at = now()
             WHERE product_id = $2 AND size = $3`,
            [resv.qty, resv.product_id, resv.size]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Mark-purchased error:', err.message);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

// GET /api/first-access/supreme/reservations — active reservations for current invite
app.get('/api/first-access/supreme/reservations', async (req, res) => {
    const token = getFirstAccessToken(req);
    const v = await validateInviteToken(token);
    if (!v.ok) return res.status(v.status).json({ error: v.error });

    const rows = await pool.query(
        `SELECT r.id, r.product_id, r.size, r.expires_at, p.title, p.article, p.price_rrc
         FROM first_access_reservations r
         JOIN first_access_products p ON p.id = r.product_id
         WHERE r.invite_id = $1 AND r.status = 'active'
         ORDER BY r.expires_at`,
        [v.invite.id]
    );

    res.json(rows.rows);
});

// ── Cron: restore wrong-expired, sync qty_reserved, then expire ──
const FIXED_EXPIRES = process.env.RESERVATION_FIXED_EXPIRES_AT || '2026-03-05T17:00:00.000Z';

function runReservationCron() {
    if (!pool) return;
    // 1) Restore: expired с expires_at в прошлом → active с правильной датой (все подряд, не только 14 дней)
    pool.query(
        `WITH to_restore AS (
            SELECT id, product_id, size, COALESCE(qty, 1) as qty FROM first_access_reservations
            WHERE status = 'expired' AND expires_at < $1::timestamptz
        ),
        restored AS (
            UPDATE first_access_reservations r SET status = 'active', expires_at = $1::timestamptz, updated_at = now()
            FROM to_restore w WHERE r.id = w.id
            RETURNING r.product_id, r.size, w.qty
        ),
        agg AS (
            SELECT product_id, size, SUM(qty)::int AS total FROM restored GROUP BY product_id, size
        )
        UPDATE first_access_product_sizes ps
        SET qty_reserved = qty_reserved + agg.total, updated_at = now()
        FROM agg WHERE ps.product_id = agg.product_id AND ps.size = agg.size`,
        [FIXED_EXPIRES]
    ).then(r => {
        if (r && r.rowCount > 0) console.log('[cron] Restored', r.rowCount, 'qty_reserved');
    }).catch(err => console.error('[cron] Restore:', err.message))
    .then(() => {
        // 2) Sync: qty_reserved = факт из active reservations
        return pool.query(
            `UPDATE first_access_product_sizes ps
             SET qty_reserved = COALESCE((
               SELECT SUM(qty)::int FROM first_access_reservations
               WHERE product_id = ps.product_id AND size = ps.size AND status = 'active'
             ), 0), updated_at = now()`
        );
    }).then(r => {
        if (r && r.rowCount > 0) console.log('[cron] Synced qty_reserved for', r.rowCount, 'rows');
    }).catch(err => console.error('[cron] Sync:', err.message))
    .then(() => {
        // 3) Expire: active с expires_at < now()
        return pool.query(
            `WITH expired AS (
                SELECT id, product_id, size, qty FROM first_access_reservations
                WHERE status = 'active' AND expires_at < now()
            ),
            marked AS (
                UPDATE first_access_reservations SET status = 'expired', updated_at = now()
                WHERE id IN (SELECT id FROM expired)
                RETURNING product_id, size, qty
            ),
            agg AS (
                SELECT product_id, size, SUM(qty)::int AS total FROM marked GROUP BY product_id, size
            )
            UPDATE first_access_product_sizes ps
            SET qty_reserved = GREATEST(0, ps.qty_reserved - COALESCE(agg.total, 0)), updated_at = now()
            FROM agg
            WHERE ps.product_id = agg.product_id AND ps.size = agg.size`
        );
    }).then(() => {}).catch(err => console.error('[cron] Expire:', err.message));
}
cron.schedule('* * * * *', runReservationCron);

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
    runReservationCron(); // fix immediately, then every minute via cron
});
