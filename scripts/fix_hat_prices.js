#!/usr/bin/env node
/**
 * One-off: set price 11 990 → 10 990 for 2 hats
 * Run: node scripts/fix_hat_prices.js
 * Requires: DATABASE_URL or DATABASE_PUBLIC_URL in .env
 */

require('dotenv').config();
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    const before = await client.query(
      `SELECT id, title, price_rrc FROM first_access_products 
       WHERE title ILIKE '%шап%' AND price_rrc = 11990 ORDER BY title LIMIT 5`
    );
    if (before.rows.length === 0) {
      console.log('No hats with 11990 found.');
      return;
    }
    console.log('Before:', before.rows.map(r => `${r.title.slice(0, 45)} — ${r.price_rrc}`).join('\n       '));

    const ids = before.rows.slice(0, 2).map(r => r.id);
    const res = await client.query(
      `UPDATE first_access_products SET price_rrc = 10990, updated_at = now()
       WHERE id = ANY($1::uuid[])
       RETURNING id, title, price_rrc`,
      [ids]
    );
    console.log('\nUpdated', res.rowCount, 'hat(s) to 10 990:');
    res.rows.forEach(r => console.log('  -', r.title.slice(0, 50), '→', r.price_rrc, '₽'));
  } finally {
    client.release();
    pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
