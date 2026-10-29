-- Trail Signal durable lobby storage.
-- Run this once in the Supabase SQL editor.
-- Only the server's service-role key can read or write this table.

create table if not exists public.lobbies (
  code text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lobbies enable row level security;

create index if not exists lobbies_updated_at_idx on public.lobbies (updated_at);
