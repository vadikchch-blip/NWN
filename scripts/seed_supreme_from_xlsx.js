#!/usr/bin/env node
/**
 * Seed Supreme First Access from xlsx
 * Usage: node scripts/seed_supreme_from_xlsx.js [path/to/file.xlsx]
 *        Use --reset to truncate products/sizes before seeding
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL, optionally IMAGE_KEY_OVERRIDES (JSON path)
 *
 * XLSX structure:
 * - Rows where "Товар" column contains "SUPREME ..." are product rows
 * - Size from tail: "S размер" / "M размер" / etc.; else OS
 * - Article from parentheses e.g. (FW25T48)
 * - "Цена розничная" = price_rrc
 * - "Количество" = qty (sum for same product+size)
 * - title = product string without size suffix (matches photo name)
 * - image_key = title, with optional overrides from image_key_overrides.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const args = process.argv.slice(2).filter(a => a !== '--reset');
const doReset = process.argv.includes('--reset');
const xlsxPath = args[0] || process.env.SUPREME_XLSX_PATH || path.join(__dirname, '..', 'data', 'ррц Supreme.xlsx');
const overridesPath = process.env.IMAGE_KEY_OVERRIDES || path.join(__dirname, '..', 'data', 'image_key_overrides.json');

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
    console.error('DATABASE_URL or DATABASE_PUBLIC_URL required');
    process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

// Parse size from product string tail
const SIZE_PATTERN = /\s+(S|M|L|XL|XXL)\s+размер\s*$/i;
function parseSize(productStr) {
    const m = (productStr || '').match(SIZE_PATTERN);
    return m ? m[1].toUpperCase() : 'OS';
}

// Parse title (without size) and article
function parseTitleAndArticle(productStr) {
    if (!productStr || typeof productStr !== 'string') return { title: '', article: '' };
    let title = productStr.replace(SIZE_PATTERN, '').trim();
    const artMatch = title.match(/\(([^)]+)\)/);
    const article = artMatch ? artMatch[1].trim() : '';
    return { title, article };
}

// Load overrides { "title1": "real_r2_filename", ... }
function loadOverrides() {
    try {
        if (fs.existsSync(overridesPath)) {
            return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
        }
    } catch (e) {}
    return {};
}

async function main() {
    if (!fs.existsSync(xlsxPath)) {
        console.error('File not found:', xlsxPath);
        process.exit(1);
    }

    const workbook = XLSX.readFile(xlsxPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    // Find header row
    let headerRow = -1;
    let colProduct = -1, colPrice = -1, colQty = -1;
    for (let i = 0; i < Math.min(data.length, 20); i++) {
        const row = data[i];
        for (let j = 0; j < row.length; j++) {
            const val = String(row[j] || '').trim();
            if (val === 'Товар') colProduct = j;
            if (val === 'Цена розничная') colPrice = j;
            if (val === 'Количество') colQty = j;
        }
        if (colProduct >= 0 && colPrice >= 0) {
            headerRow = i;
            break;
        }
    }

    if (headerRow < 0 || colProduct < 0 || colPrice < 0) {
        console.error('Could not find headers (Товар, Цена розничная, Количество)');
        process.exit(1);
    }
    if (colQty < 0) colQty = colPrice + 1;

    const overrides = loadOverrides();

    // Aggregate: (title, article, color?, size) -> { price_rrc, qty_total }
    const aggregated = new Map();

    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i];
        const productStr = String(row[colProduct] || '').trim();
        if (!productStr.toUpperCase().includes('SUPREME')) continue;

        const priceVal = row[colPrice];
        const priceRrc = typeof priceVal === 'number' ? Math.round(priceVal) : parseInt(String(priceVal || '0').replace(/\D/g, ''), 10) || 0;
        const qty = parseInt(String(row[colQty] || '0').replace(/\D/g, ''), 10) || 0;

        if (!productStr || priceRrc <= 0) continue;

        const size = parseSize(productStr);
        const { title, article } = parseTitleAndArticle(productStr);
        if (!title) continue;

        const imageKey = overrides[title] || title;
        const key = `${title}|||${article}|||${size}`;

        if (!aggregated.has(key)) {
            aggregated.set(key, { title, article, imageKey, price_rrc: priceRrc, size, qty_total: 0 });
        }
        aggregated.get(key).qty_total += qty;
    }

    const entries = Array.from(aggregated.values());
    console.log(`Parsed ${entries.length} product-size entries`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (doReset) {
            await client.query('TRUNCATE first_access_product_sizes, first_access_products CASCADE');
            console.log('Cleared products and sizes (reservations referencing products are also removed).');
        }

        // Group by (title, article, imageKey) for products; sizes as children
        const productMap = new Map();
        for (const e of entries) {
            const pk = `${e.title}|||${e.article}|||${e.imageKey}`;
            if (!productMap.has(pk)) {
                productMap.set(pk, { title: e.title, article: e.article, image_key: e.imageKey, price_rrc: e.price_rrc, sizes: [] });
            }
            productMap.get(pk).sizes.push({ size: e.size, qty_total: e.qty_total });
        }

        for (const prod of productMap.values()) {
            const ins = await client.query(
                `INSERT INTO first_access_products (brand, article, title, image_key, price_rrc)
                 VALUES ('Supreme', $1, $2, $3, $4)
                 RETURNING id`,
                [prod.article || prod.title, prod.title, prod.image_key, prod.price_rrc]
            );
            const productId = ins.rows[0].id;

            for (const s of prod.sizes) {
                await client.query(
                    `INSERT INTO first_access_product_sizes (product_id, size, qty_total)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (product_id, size) DO UPDATE SET qty_total = first_access_product_sizes.qty_total + $3`,
                    [productId, s.size, s.qty_total]
                );
            }
        }

        await client.query('COMMIT');
        console.log('Seed complete.');
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
