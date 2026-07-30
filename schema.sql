-- Kenyan Excellence Awards — Supabase schema
-- Run this in the Supabase SQL editor (or via `supabase db push`)

create extension if not exists "pgcrypto";

-- Admin users (separate from nominee/public data — no public signup)
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  full_name text,
  created_at timestamptz default now()
);

-- Award categories, e.g. "Best Radio Presenter"
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  section text not null, -- e.g. 'entertainment', 'politics', 'literature'
  description text,
  is_active boolean default true, -- admin can open/close voting per category
  display_order int default 0,
  created_at timestamptz default now()
);

-- Nominees within a category
create table if not exists nominees (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references categories(id) on delete cascade,
  full_name text not null,
  organization text,       -- e.g. station, party, employer
  county text,
  bio text,
  photo_url text,
  social_links jsonb default '{}'::jsonb,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- One row per STK Push payment attempt, regardless of outcome
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  nominee_id uuid references nominees(id),
  phone_number text not null,
  amount numeric not null,
  votes_requested int not null,
  status text not null default 'pending', -- pending | success | failed | cancelled
  fxs_reference text,           -- FXS Pay's own transaction/checkout id
  mpesa_receipt text,           -- populated from callback on success
  result_code text,
  result_desc text,
  raw_callback jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One row per vote actually credited (only ever inserted after a
-- confirmed successful payment callback — never on the initiate step)
create table if not exists votes (
  id uuid primary key default gen_random_uuid(),
  nominee_id uuid references nominees(id),
  transaction_id uuid references transactions(id),
  created_at timestamptz default now()
);

create index if not exists idx_votes_nominee on votes(nominee_id);
create index if not exists idx_transactions_status on transactions(status);
create index if not exists idx_nominees_category on nominees(category_id);

-- Public, read-only view of vote counts per nominee (safe to expose
-- because it only ever aggregates — no phone numbers, no transaction data)
create or replace view public_vote_counts as
select
  n.id as nominee_id,
  n.full_name,
  n.category_id,
  count(v.id) as vote_count
from nominees n
left join votes v on v.nominee_id = n.id
group by n.id, n.full_name, n.category_id;
