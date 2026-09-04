-- Optiary schema, ported from the SQLite definition in server/src/db.ts.
--
-- Two deliberate choices keep this a faithful port rather than a redesign:
--
--   * Timestamps stay `text` holding ISO-8601 strings. The application reads and
--     writes them as strings everywhere (`nowIso()`), so promoting them to
--     `timestamptz` would change what supabase-js hands back and ripple through
--     the whole codebase for no gain.
--   * JSON columns stay `text` for the same reason: the code does its own
--     JSON.parse/stringify, and `jsonb` would return already-parsed objects and
--     break every call site.
--
-- Authorization lives in the server, not in the database: every store function
-- takes a `userId` and filters by it, and the server connects with the
-- service_role key. RLS is therefore enabled with no policies at all — that
-- denies every anon/authenticated request outright while service_role bypasses
-- it, so a leaked publishable key exposes nothing.

create table if not exists users (
  id          text primary key,
  google_sub  text unique,
  email       text not null unique,
  name        text not null,
  picture     text,
  settings    text not null default '{}',
  created_at  text not null
);

create table if not exists entries (
  id          text primary key,
  user_id     text not null references users (id) on delete cascade,
  date        text not null,
  slot        text not null,
  note        text not null default '',
  tags        text not null default '[]',
  metrics     text not null default '{}',
  updated_at  text not null,
  unique (user_id, date, slot)
);

-- `filename` used to name a file under data/uploads; it is now the object path
-- inside the `optiary` storage bucket. The column keeps its name so the store
-- functions and their callers stay unchanged.
create table if not exists images (
  id          text primary key,
  user_id     text not null references users (id) on delete cascade,
  date        text not null,
  slot        text not null,
  kind        text not null,
  filename    text not null,
  mime        text not null,
  bytes       integer not null,
  created_at  text not null,
  unique (user_id, date, slot, kind)
);

create table if not exists messages (
  id          text primary key,
  user_id     text not null references users (id) on delete cascade,
  thread      text not null,
  role        text not null,
  content     text not null,
  meta        text not null default '{}',
  created_at  text not null
);

create table if not exists chat_attachments (
  id          text primary key,
  user_id     text not null references users (id) on delete cascade,
  message_id  text not null,
  filename    text not null,
  mime        text not null,
  bytes       integer not null,
  created_at  text not null
);

create table if not exists day_news (
  user_id       text not null references users (id) on delete cascade,
  date          text not null,
  events        text not null default '[]',
  week_summary  text not null default '',
  updated_at    text not null,
  primary key (user_id, date)
);

create index if not exists idx_entries_user_date on entries (user_id, date);
create index if not exists idx_images_user_date on images (user_id, date);
create index if not exists idx_messages_thread on messages (user_id, thread, created_at);
create index if not exists idx_chat_attachments_message on chat_attachments (message_id);
create index if not exists idx_day_news_user_date on day_news (user_id, date);

alter table users            enable row level security;
alter table entries          enable row level security;
alter table images           enable row level security;
alter table messages         enable row level security;
alter table chat_attachments enable row level security;
alter table day_news         enable row level security;

-- Private bucket for session screenshots and chat attachments. Reads and writes
-- go through the server with the service_role key, which bypasses storage
-- policies, so — as with the tables — no policies are defined here.
insert into storage.buckets (id, name, public)
values ('optiary', 'optiary', false)
on conflict (id) do nothing;
