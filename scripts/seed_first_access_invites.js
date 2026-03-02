#!/usr/bin/env node
/**
 * Seed First Access invites from Excel "Список клиентов.xlsx"
 * Usage: node scripts/seed_first_access_invites.js [path/to/file.xlsx]
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL
 *      FIRST_ACCESS_INVITES_XLSX (optional, path to xlsx)
 *      FIRST_ACCESS_STARTS_AT, FIRST_ACCESS_ENDS_AT (optional, ISO dates)
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const rootDir = path.join(__dirname, '..');
const defaultXlsxPath = path.join(rootDir, 'Список клиентов.xlsx');
const xlsxPath = process.env.FIRST_ACCESS_INVITES_XLSX || process.argv[2] || defaultXlsxPath;

const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) {
    console.error('DATABASE_URL or DATABASE_PUBLIC_URL required');
    process.exit(1);
}

if (!fs.existsSync(xlsxPath)) {
    console.error('File not found:', xlsxPath);
    process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

function parseAccessPeriod() {
    const fromEnv = process.env.FIRST_ACCESS_STARTS_AT;
    const toEnv = process.env.FIRST_ACCESS_ENDS_AT;
    if (fromEnv && toEnv) {
        const from = new Date(fromEnv);
        const to = new Date(toEnv);
        if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) return { from, to };
    }
    const from = new Date();
    const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { from, to };
}

function getFullNameFromRow(row, colFio, colSurname, colName) {
    if (colFio >= 0 && row[colFio] != null) {
        const s = String(row[colFio] || '').trim();
        if (s) return s;
    }
    if (colSurname >= 0 && colName >= 0) {
        const surname = String(row[colSurname] || '').trim();
        const name = String(row[colName] || '').trim();
        const full = [surname, name].filter(Boolean).join(' ');
        if (full) return full;
    }
    if (colName >= 0 && row[colName] != null) {
        const s = String(row[colName] || '').trim();
        if (s) return s;
    }
    return null;
}

function detectColumns(data) {
    let colFio = -1, colSurname = -1, colName = -1;
    const headerRow = data[0] || [];
    for (let j = 0; j < headerRow.length; j++) {
        const val = String(headerRow[j] || '').trim().toLowerCase();
        if (val === 'фио' || val === 'ф.и.о' || val.includes('full name')) colFio = j;
        if (val === 'фамилия') colSurname = j;
        if (val === 'имя') colName = j;
    }
    return { colFio, colSurname, colName };
}

function generateToken() {
    return crypto.randomUUID().replace(/-/g, '');
}

async function main() {
    const workbook = XLSX.readFile(xlsxPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (data.length < 2) {
        console.error('Not enough rows (need header + at least one data row)');
        process.exit(1);
    }

    const { colFio, colSurname, colName } = detectColumns(data);
    const hasAny = colFio >= 0 || (colSurname >= 0 && colName >= 0) || colName >= 0;
    if (!hasAny) {
        console.error('Could not find columns: need "ФИО", or "Имя", or "Фамилия" + "Имя"');
        process.exit(1);
    }

    const names = [];
    for (let i = 1; i < data.length; i++) {
        const fullName = getFullNameFromRow(data[i], colFio, colSurname, colName);
        if (fullName) names.push(fullName);
    }

    console.log('Rows to process:', names.length);
    if (names.length === 0) {
        console.log('No names to create invites for.');
        process.exit(0);
    }

    const { from, to } = parseAccessPeriod();
    console.log('Access period:', from.toISOString(), '—', to.toISOString());

    const client = await pool.connect();
    let created = 0;
    try {
        await client.query('BEGIN');
        for (const fullName of names) {
            let token = generateToken();
            let attempts = 0;
            while (attempts < 5) {
                try {
                    await client.query(
                        `INSERT INTO first_access_invites (token, full_name, access_starts_at, access_ends_at)
                         VALUES ($1, $2, $3, $4)`,
                        [token, fullName, from, to]
                    );
                    created++;
                    break;
                } catch (err) {
                    if (err.code === '23505') {
                        token = generateToken();
                        attempts++;
                    } else {
                        console.error('Error for', fullName, err.message);
                        break;
                    }
                }
            }
        }
        await client.query('COMMIT');
        console.log('Created invites:', created);
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
