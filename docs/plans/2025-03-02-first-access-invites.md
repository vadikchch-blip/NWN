# First Access Invites & Admin Page — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add script to create First Access invites from Excel "Список клиентов.xlsx", and a separate admin page to list invites (with copy link) and all reservations.

**Architecture:** Script reads Excel, inserts into `first_access_invites` with unique tokens. New admin-only API endpoints return invites and reservations. New HTML page `admin-first-access.html` consumes these APIs and shows tables with copy-to-clipboard for invite URLs.

**Tech Stack:** Node.js, Express, pg, xlsx, existing JWT + requireAdmin.

---

## Task 1: Admin API — GET /api/first-access/admin/invites

**Files:**
- Modify: `server.js` (after existing requireAdmin and first-access routes, ~385)

**Steps:**

1. Add two new routes using `requireAdmin`:
   - `GET /api/first-access/admin/invites`: query `first_access_invites` (id, full_name, token, access_starts_at, access_ends_at, is_active, created_at). For each row add `invite_url`: base URL from `process.env.BASE_URL || process.env.APP_URL` or build from req (protocol + host) + `/access/supreme-first-access.html?token=` + token. Order by created_at DESC. Return JSON array.
2. Ensure BASE_URL has no trailing slash when building invite_url.
3. Manually test: start server, as admin call `GET /api/first-access/admin/invites` with Bearer token — expect 200 and array (possibly empty).

---

## Task 2: Admin API — GET /api/first-access/admin/reservations

**Files:**
- Modify: `server.js` (same area as Task 1)

**Steps:**

1. Add `GET /api/first-access/admin/reservations`: query with JOINs: `first_access_reservations` + `first_access_invites.full_name` + `first_access_products` (title, article, brand). Return id, guest full_name, product title/article, size, status, reserved_at, expires_at. Order by reserved_at DESC. Optional query param `status` (e.g. active) to filter. Use requireAdmin.
2. Manually test: call with Bearer token — expect 200 and array.

---

## Task 3: Script seed_first_access_invites.js — structure and Excel read

**Files:**
- Create: `scripts/seed_first_access_invites.js`

**Steps:**

1. Require dotenv, path, fs, pg, xlsx. Load DATABASE_PUBLIC_URL || DATABASE_URL. Default xlsx path: path.join(__dirname, '..', 'Список клиентов.xlsx'); override from process.env.FIRST_ACCESS_INVITES_XLSX or argv[0]. Exit with message if file not found.
2. Parse Excel: first sheet, sheet_to_json with header: 1. Detect columns: find header row (first row that has a cell matching ФИО / Имя / Full name / Фамилия). If "Фамилия" and "Имя" exist, use both; else use single column for full name. Normalize full_name trim.
3. Skip empty full_name rows. Log number of rows to process.
4. Do not insert yet — next task will add DB insert with token generation.

---

## Task 4: Script — token generation and DB insert

**Files:**
- Modify: `scripts/seed_first_access_invites.js`
- Optional: add `nanoid` to package.json if not present (or use crypto.randomUUID for token).

**Steps:**

1. For each row with full_name: generate unique token (e.g. require('crypto').randomUUID() or nanoid(21)). Insert into first_access_invites: token, full_name, access_starts_at, access_ends_at. Use env FIRST_ACCESS_STARTS_AT / FIRST_ACCESS_ENDS_AT (ISO) or default now() and now() + 7 days. On unique token conflict retry with new token.
2. Run in transaction (BEGIN/COMMIT). Log created count and any errors per row.
3. Test: create a small Excel with 2–3 rows (columns ФИО or Фамилия/Имя), run script, then check DB or call GET /api/first-access/admin/invites.

---

## Task 5: admin-first-access.html — shell and auth

**Files:**
- Create: `admin-first-access.html`

**Steps:**

1. Copy header and auth pattern from admin.html: same head (Tailwind, fonts), same header bar with nwn logo and "First Access" subtitle, logout. Script: read nwn_token from localStorage, redirect to login if missing. Call GET /api/auth/me; if !user || user.role_id !== 1 redirect and alert "Доступ только для администраторов".
2. Add two sections in main: "Инвайты" (table placeholder) and "Бронирования" (table placeholder). No data yet.
3. Open /admin-first-access.html when not logged in — must redirect to login. Logged in as admin — page loads.

---

## Task 6: admin-first-access.html — Invites table and copy link

**Files:**
- Modify: `admin-first-access.html`

**Steps:**

1. On load call GET /api/first-access/admin/invites. Render table: ФИО, Ссылка (invite_url), Активен до, Статус (is_active). In "Ссылка" column add a "Копировать" button that copies invite_url to clipboard (navigator.clipboard.writeText) and shows brief feedback (e.g. "Скопировано").
2. Style table like admin.html (same th/td classes). Format dates with toLocaleDateString('ru-RU').

---

## Task 7: admin-first-access.html — Reservations table

**Files:**
- Modify: `admin-first-access.html`

**Steps:**

1. On load call GET /api/first-access/admin/reservations. Render table: Гость, Товар (title + article), Размер, Статус, Дата резерва. Same styling. Optional: add filter by status (e.g. dropdown "Все" / "Активные") and pass ?status=active to API.
2. If no data, show "Нет бронирований" in table body.

---

## Task 8: Allow admin-first-access in public/list and link from admin

**Files:**
- Modify: `server.js` (PUBLIC_PAGES or static/auth if needed)
- Modify: `admin.html` (optional: add link to First Access admin)

**Steps:**

1. Ensure /admin-first-access.html is not blocked and is served as static file (current setup: not in FILE_TO_SLUG so it’s served; no change needed unless you use a catch-all that blocks it). If there is a catch-all auth for *.html, add an exception for admin-first-access.html so that the page loads (API still requires admin).
2. In admin.html add a small link "First Access" (to /admin-first-access.html) in the header or under tabs so admins can switch to the new page.

---

## Task 9: Documentation and commit

**Files:**
- Modify: `README.md` or add short note in docs/plans

**Steps:**

1. Add one paragraph: how to create invites (put "Список клиентов.xlsx" in project root, run `node scripts/seed_first_access_invites.js`, optional env FIRST_ACCESS_INVITES_XLSX, FIRST_ACCESS_STARTS_AT, FIRST_ACCESS_ENDS_AT). Admin page: /admin-first-access.html for invite list and reservations.
2. Commit all changes with a single message or per-task messages as preferred.
