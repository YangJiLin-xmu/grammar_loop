-- Business state is deliberately server-only: practice answer keys must not be
-- readable via Supabase's public Data API before an attempt is submitted.
create table if not exists public.gl_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1,
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.gl_workspaces enable row level security;
revoke all on public.gl_workspaces from anon, authenticated;
grant select, insert, update, delete on public.gl_workspaces to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('grammar-loop', 'grammar-loop', false, 10485760, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = false;
-- No client policies: BFF checks ownership before reading private images.
-- pg-boss creates its queue schema through DATABASE_URL when the worker starts.
