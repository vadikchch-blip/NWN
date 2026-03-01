-- NWN Supreme First Access — schema
-- Run against Railway PostgreSQL

-- A) Invites (token-based access)
CREATE TABLE IF NOT EXISTS first_access_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    phone TEXT,
    note TEXT,
    access_starts_at TIMESTAMPTZ NOT NULL,
    access_ends_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_first_access_invites_token ON first_access_invites(token);
CREATE INDEX IF NOT EXISTS idx_first_access_invites_active ON first_access_invites(is_active) WHERE is_active = true;

-- B) Products
CREATE TABLE IF NOT EXISTS first_access_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand TEXT DEFAULT 'Supreme',
    article TEXT NOT NULL,
    title TEXT NOT NULL,
    color TEXT,
    category TEXT,
    image_key TEXT NOT NULL,
    price_rrc INT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_first_access_products_active ON first_access_products(is_active) WHERE is_active = true;

-- C) Product sizes
CREATE TABLE IF NOT EXISTS first_access_product_sizes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES first_access_products(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    qty_total INT NOT NULL,
    qty_reserved INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(product_id, size)
);

CREATE INDEX IF NOT EXISTS idx_first_access_product_sizes_product ON first_access_product_sizes(product_id);

-- D) Reservations
CREATE TABLE IF NOT EXISTS first_access_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_id UUID NOT NULL REFERENCES first_access_invites(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES first_access_products(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    qty INT DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',  -- active | expired | cancelled | purchased
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_first_access_reservations_invite ON first_access_reservations(invite_id);
CREATE INDEX IF NOT EXISTS idx_first_access_reservations_product ON first_access_reservations(product_id);
CREATE INDEX IF NOT EXISTS idx_first_access_reservations_expires ON first_access_reservations(expires_at) WHERE status = 'active';

-- Partial unique: one active reservation per (invite_id, product_id, size)
CREATE UNIQUE INDEX IF NOT EXISTS idx_first_access_reservations_unique_active
ON first_access_reservations(invite_id, product_id, size)
WHERE status = 'active';

-- E) Events (optional, for audit)
CREATE TABLE IF NOT EXISTS first_access_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_first_access_events_type ON first_access_events(event_type);
CREATE INDEX IF NOT EXISTS idx_first_access_events_created ON first_access_events(created_at);
