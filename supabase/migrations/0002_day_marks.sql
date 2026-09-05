-- Day-level judgements: whether the session ran short or long gamma, and the
-- note that goes with the "reveal" chart.
--
-- They land on day_news because that table is already the one row per (user,
-- date) — it started as news and is now the day record. The reveal and pre-news
-- screenshots need no schema of their own: they go in `images` under the
-- reserved slot id `day`, which the existing unique (user_id, date, slot, kind)
-- already keeps to one of each per day.

alter table day_news
  add column if not exists gamma        text,
  add column if not exists gamma_source text,
  add column if not exists reveal_note  text not null default '';

-- Only the two regimes, and only the two provenances, are meaningful. A bad
-- value here would surface as a mislabelled day rather than an error, so it is
-- rejected at the door instead.
alter table day_news
  drop constraint if exists day_news_gamma_check;
alter table day_news
  add constraint day_news_gamma_check
  check (gamma is null or gamma in ('short', 'long'));

alter table day_news
  drop constraint if exists day_news_gamma_source_check;
alter table day_news
  add constraint day_news_gamma_source_check
  check (gamma_source is null or gamma_source in ('ai', 'user'));
