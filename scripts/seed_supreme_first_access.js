#!/usr/bin/env node
/**
 * Seed Supreme First Access from ррц Supreme.xlsx
 * Usage: node scripts/seed_supreme_first_access.js [path/to/file.xlsx]
 *        --force  truncate and recreate catalog completely
 *
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL
 *      SUPREME_XLSX_PATH (optional, default: data/ррц Supreme.xlsx)
 *      IMAGE_KEY_OVERRIDES (optional, path to JSON for title->r2_filename)
 *
 * Columns: Товар, Количество, Цена розничная
 * Example row: SUPREME S Logo S/S Top Black (FW25T48) M размер
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const doForce = process.argv.includes('--force');
const args = process.argv.slice(2).filter(a => a !== '--force');
const xlsxUrl = process.env.SUPREME_XLSX_URL;
const rootDir = path.join(__dirname, '..');
const defaultPaths = [
    path.join(rootDir, 'ррц Supreme.xlsx')       // корень репо (основной источник)
];
const xlsxPath = args[0] || process.env.SUPREME_XLSX_PATH;
const overridesPath = process.env.IMAGE_KEY_OVERRIDES || path.join(__dirname, '..', 'data', 'image_key_overrides.json');

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
    console.error('DATABASE_URL or DATABASE_PUBLIC_URL required');
    process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

// Remove "S размер", "M размер", "L размер", "XL размер" from tail
const SIZE_PATTERN = /\s+(S|M|L|XL|XXL)\s+размер\s*$/i;
const SIZE_OR_JUST_RAZMER = /\s+размер\s*$/i; // fallback: just "размер" at end

function parseSize(productStr) {
    const m = (productStr || '').match(SIZE_PATTERN);
    return m ? m[1].toUpperCase() : 'OS';
}

function parseTitleAndArticle(productStr) {
    if (!productStr || typeof productStr !== 'string') return { title: '', article: '' };
    let title = productStr
        .replace(SIZE_PATTERN, '')  // remove "M размер" etc.
        .replace(SIZE_OR_JUST_RAZMER, '')  // remove lone "размер"
        .trim();
    const artMatch = title.match(/\(([^)]+)\)/);
    const article = artMatch ? artMatch[1].trim() : '';
    return { title, article };
}

function loadOverrides() {
    try {
        if (fs.existsSync(overridesPath)) {
            const data = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
            if (typeof data !== 'object' || Array.isArray(data)) return {};
            const out = {};
            for (const [k, v] of Object.entries(data)) {
                if (!k.startsWith('_') && typeof v === 'string') out[k] = v;
            }
            return out;
        }
    } catch (e) {}
    return {};
}

function parsePrice(val) {
    if (typeof val === 'number' && !Number.isNaN(val)) return Math.round(val);
    const s = String(val || '0').replace(/\s/g, '').replace(/[^\d]/g, '');
    return parseInt(s, 10) || 0;
}

function parseQty(val) {
    const s = String(val || '0').replace(/\D/g, '');
    return parseInt(s, 10) || 0;
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

async function main() {
    let workbook;
    if (xlsxUrl) {
        try {
            const buf = await fetchBuffer(xlsxUrl);
            workbook = XLSX.read(buf, { type: 'buffer' });
            console.log('Loaded xlsx from URL');
        } catch (e) {
            console.error('Failed to fetch xlsx:', e.message);
            process.exit(1);
        }
    } else {
        const found = xlsxPath ? (fs.existsSync(xlsxPath) ? xlsxPath : null)
            : defaultPaths.find(p => fs.existsSync(p));
        if (found) {
            workbook = XLSX.readFile(found);
            console.log('Loaded xlsx from', found);
        } else {
            console.warn('Supreme xlsx not found - skip seed. Put file in repo root or data/');
            process.exit(0);
        }
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    let headerRow = -1;
    let colProduct = -1, colPrice = -1, colQty = -1;
    for (let i = 0; i < Math.min(data.length, 50); i++) {
        const row = data[i] || [];
        for (let j = 0; j < row.length; j++) {
            const val = String(row[j] || '').trim();
            if (val === 'Товар' || val.toLowerCase().includes('товар')) colProduct = j;
            if (val === 'Цена розничная' || (val.includes('Цена') && val.includes('розничн'))) colPrice = j;
            if (val === 'Количество' || val.toLowerCase().includes('количество')) colQty = j;
        }
        if (colProduct >= 0 && colPrice >= 0) {
            headerRow = i;
            break;
        }
    }

    if (headerRow < 0 || colProduct < 0 || colPrice < 0) {
        console.error('Headers not found: need Товар, Цена розничная (and Количество if present)');
        process.exit(1);
    }
    if (colQty < 0) colQty = colPrice + 1;

    const overrides = loadOverrides();
    const skipped = [];
    const aggregated = new Map(); // key = title|size -> { title, article, size, price_rrc, qty_total }

    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i] || [];
        const productStr = String(row[colProduct] || '').trim();
        if (!productStr.toUpperCase().includes('SUPREME')) continue;

        const priceRrc = parsePrice(row[colPrice]);
        const qty = parseQty(row[colQty]);

        // Validation
        if (!productStr) {
            skipped.push({ row: i + 1, reason: 'empty title' });
            continue;
        }
        if (priceRrc <= 0) {
            skipped.push({ row: i + 1, product: productStr.slice(0, 50), reason: 'price <= 0' });
            continue;
        }
        if (qty < 0) {
            skipped.push({ row: i + 1, product: productStr.slice(0, 50), reason: 'qty < 0' });
            continue;
        }

        const size = parseSize(productStr);
        const { title, article } = parseTitleAndArticle(productStr);
        if (!title) {
            skipped.push({ row: i + 1, product: productStr.slice(0, 50), reason: 'empty title after parse' });
            continue;
        }

        const key = `${title}|||${size}`;
        if (!aggregated.has(key)) {
            aggregated.set(key, { title, article, size, price_rrc: priceRrc, qty_total: 0, raw_product_str: productStr });
        }
        aggregated.get(key).qty_total += qty;
    }

    // Group by title (one product per title)
    // image_key: если есть размеры S/M/L/XL — raw_product_str (фото в R2 с размером в имени)
    // если только OS — title
    const productMap = new Map(); // title -> { title, article, price_rrc, image_key, sizedRaw, sizes: [] }
    for (const e of aggregated.values()) {
        if (!productMap.has(e.title)) {
            productMap.set(e.title, {
                title: e.title,
                article: e.article,
                price_rrc: e.price_rrc,
                image_key: e.title,
                sizedRaw: null,
                sizes: []
            });
        }
        const p = productMap.get(e.title);
        p.sizes.push({ size: e.size, qty_total: e.qty_total });
        if (e.size !== 'OS' && !p.sizedRaw) p.sizedRaw = e.raw_product_str;
    }
    for (const p of productMap.values()) {
        if (p.sizedRaw) p.image_key = p.sizedRaw;
        delete p.sizedRaw;
    }

    const products = Array.from(productMap.values());
    const totalSizes = products.reduce((acc, p) => acc + p.sizes.length, 0);

    console.log('Parsed:', products.length, 'products,', totalSizes, 'sizes');
    if (skipped.length) {
        console.log('Skipped', skipped.length, 'rows:', skipped.slice(0, 5).map(s => JSON.stringify(s)).join(', '));
        if (skipped.length > 5) console.log('... and', skipped.length - 5, 'more');
    }

    const client = await pool.connect();
    let productsCreated = 0;
    let productsUpdated = 0;
    let sizesCreated = 0;

    try {
        await client.query('BEGIN');

        if (doForce) {
            await client.query('TRUNCATE first_access_product_sizes, first_access_products CASCADE');
            console.log('Cleared catalog (--force).');
        }

        for (const prod of products) {
            const imageKey = (overrides[prod.title] || prod.image_key || prod.title).trim();
            const existing = await client.query(
                'SELECT id FROM first_access_products WHERE title = $1',
                [prod.title]
            );

            let productId;
            if (existing.rows.length > 0 && !doForce) {
                productId = existing.rows[0].id;
                await client.query(
                    'UPDATE first_access_products SET price_rrc = $1, image_key = $2, article = $3, is_active = true, updated_at = now() WHERE id = $4',
                    [prod.price_rrc, imageKey, prod.article || prod.title, productId]
                );
                productsUpdated++;
            } else {
                const ins = await client.query(
                    `INSERT INTO first_access_products (brand, article, title, image_key, price_rrc)
                     VALUES ('Supreme', $1, $2, $3, $4)
                     RETURNING id`,
                    [prod.article || prod.title, prod.title, imageKey, prod.price_rrc]
                );
                productId = ins.rows[0].id;
                productsCreated++;
            }

            // Replace sizes: delete existing, insert new (idempotent: --force already truncated)
            if (!doForce) {
                await client.query('DELETE FROM first_access_product_sizes WHERE product_id = $1', [productId]);
            }

            for (const s of prod.sizes) {
                await client.query(
                    `INSERT INTO first_access_product_sizes (product_id, size, qty_total)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (product_id, size) DO UPDATE SET qty_total = $3, updated_at = now()`,
                    [productId, s.size, s.qty_total]
                );
                sizesCreated++;
            }
        }

        // Отключить товары Supreme, которых нет в текущем xlsx (удалённые позиции)
        const currentTitles = products.map(p => p.title);
        const deact = await client.query(
            `UPDATE first_access_products SET is_active = false, updated_at = now()
             WHERE brand = 'Supreme' AND title != ALL($1::text[])
             RETURNING id`,
            [currentTitles]
        );
        const deactivatedCount = deact.rowCount || 0;
        if (deactivatedCount > 0) {
            console.log('  Deactivated (not in xlsx):', deactivatedCount);
        }

        await client.query('COMMIT');

        console.log('\nSummary:');
        console.log('  Products created:', productsCreated);
        console.log('  Products updated:', productsUpdated);
        console.log('  Sizes created/updated:', sizesCreated);
        console.log('  Total products in catalog:', products.length);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        process.exit(1);
    } finally {
        client.release();
        pool.end();
    }
}

main();
