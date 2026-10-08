-- Skyline Sermon Search — Supabase schema
--
-- Run once in the Supabase SQL editor (and again after pulling changes —
-- every statement here is safe to re-run).
--
-- Two tables:
--   sermons   one row per podcast episode (metadata + transcription status)
--   passages  ~45–90 second slices of each transcript, each with its start time,
--             a full-text index (exact words/phrases) and an embedding (meaning)
--
-- Reads are public (it's a public sermon archive); writes only happen from the
-- ingest job using the service-role key, which bypasses RLS.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- ── Tables ────────────────────────────────────────────────────────────────

create table if not exists public.sermons (
  id                bigint generated always as identity primary key,
  guid              text not null unique,          -- RSS <guid>, stable per episode
  title             text not null,
  description       text,
  speaker           text,
  series            text,
  published_at      timestamptz,
  audio_url         text not null,
  episode_url       text,
  image_url         text,
  duration_sec      integer,
  transcript_status text not null default 'pending'
                    check (transcript_status in ('pending','processing','done','error','skipped')),
  transcript_error  text,
  transcribed_at    timestamptz,
  -- Compact sentence-level transcript: [[start_sec, end_sec, "text"], ...].
  -- Kept so passages can be re-chunked/re-embedded later without paying to
  -- transcribe the audio again.
  sentences         jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists sermons_published_at_idx on public.sermons (published_at desc);
create index if not exists sermons_status_idx on public.sermons (transcript_status);

create table if not exists public.passages (
  id         bigint generated always as identity primary key,
  sermon_id  bigint not null references public.sermons(id) on delete cascade,
  idx        integer not null,                     -- order within the sermon
  start_sec  real not null,
  end_sec    real not null,
  text       text not null,
  tsv        tsvector generated always as (to_tsvector('english', text)) stored,
  embedding  extensions.vector(768),               -- @cf/baai/bge-base-en-v1.5
  unique (sermon_id, idx)
);

create index if not exists passages_tsv_idx on public.passages using gin (tsv);
create index if not exists passages_sermon_idx on public.passages (sermon_id, idx);
create index if not exists passages_embedding_idx on public.passages
  using hnsw (embedding extensions.vector_cosine_ops);

-- ── Row Level Security: public read, no public writes ─────────────────────

alter table public.sermons  enable row level security;
alter table public.passages enable row level security;

drop policy if exists "public read sermons" on public.sermons;
create policy "public read sermons" on public.sermons for select using (true);

drop policy if exists "public read passages" on public.passages;
create policy "public read passages" on public.passages for select using (true);

-- ── Hybrid search ─────────────────────────────────────────────────────────
--
-- Runs a keyword search (Postgres full-text: stemming, "quoted phrases",
-- -exclusions via websearch_to_tsquery) and a semantic search (cosine
-- distance on embeddings) and merges them with Reciprocal Rank Fusion, so a
-- passage that ranks well in either list surfaces, and one that ranks well in
-- both rises to the top.
--
-- sort_by = 'newest' | 'oldest' answers "when was this said?": it returns
-- keyword matches only (ordering fuzzy semantic matches by date isn't
-- meaningful), in date order.

create or replace function public.search_passages(
  query_text       text,
  query_embedding  extensions.vector(768) default null,
  match_count      int     default 20,
  match_offset     int     default 0,
  sort_by          text    default 'relevance',
  filter_speaker   text    default null,
  filter_year      int     default null,
  min_similarity   float   default 0.5,
  full_text_weight float   default 1.0,
  semantic_weight  float   default 1.0,
  rrf_k            int     default 50
)
returns table (
  passage_id    bigint,
  sermon_id     bigint,
  start_sec     real,
  end_sec       real,
  snippet       text,
  title         text,
  speaker       text,
  series        text,
  published_at  timestamptz,
  audio_url     text,
  episode_url   text,
  image_url     text,
  score         float,
  similarity    float,
  keyword_match boolean
)
language sql
stable
set search_path = public, extensions
as $$
with q as (
  select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq
),
full_text as (
  select p.id,
         row_number() over (order by ts_rank_cd(p.tsv, q.tsq) desc, p.id) as rank_ix
  from passages p
  join sermons s on s.id = p.sermon_id
  cross join q
  where p.tsv @@ q.tsq
    and (filter_speaker is null or s.speaker = filter_speaker)
    and (filter_year is null or extract(year from s.published_at) = filter_year)
  -- Date sorts must pick by date *before* limiting, or a common word's
  -- newest/oldest use could fall outside a relevance-ranked cutoff.
  order by
    case when sort_by = 'newest' then s.published_at end desc nulls last,
    case when sort_by = 'oldest' then s.published_at end asc nulls last,
    rank_ix
  limit case when sort_by = 'relevance' then (match_count + match_offset) * 2
             else match_count + match_offset end
),
nearest as (
  select p.id, p.embedding <=> query_embedding as dist
  from passages p
  join sermons s on s.id = p.sermon_id
  where query_embedding is not null
    and sort_by = 'relevance'
    and semantic_weight > 0
    and p.embedding is not null
    and (filter_speaker is null or s.speaker = filter_speaker)
    and (filter_year is null or extract(year from s.published_at) = filter_year)
  order by dist
  limit (match_count + match_offset) * 2
),
semantic as (
  select id,
         row_number() over (order by dist) as rank_ix,
         1 - dist as similarity
  from nearest
  where 1 - dist >= min_similarity
),
combined as (
  select coalesce(ft.id, sem.id) as id,
         coalesce(full_text_weight / (rrf_k + ft.rank_ix), 0.0)
           + coalesce(semantic_weight / (rrf_k + sem.rank_ix), 0.0) as score,
         sem.similarity,
         ft.id is not null as keyword_match
  from full_text ft
  full outer join semantic sem on ft.id = sem.id
)
select p.id, s.id, p.start_sec, p.end_sec,
       ts_headline('english', p.text, q.tsq,
                   'StartSel="[[", StopSel="]]", HighlightAll=true'),
       s.title, s.speaker, s.series, s.published_at,
       s.audio_url, s.episode_url, s.image_url,
       c.score, c.similarity, c.keyword_match
from combined c
join passages p on p.id = c.id
join sermons s on s.id = p.sermon_id
cross join q
order by
  case when sort_by = 'newest' then s.published_at end desc nulls last,
  case when sort_by = 'oldest' then s.published_at end asc nulls last,
  c.score desc,
  p.start_sec
limit match_count
offset match_offset;
$$;

-- Swap in a sermon's passages in one transaction, so a failed write never
-- leaves it with no passages or half of them. Ingest-only (service role).
-- rows: [{"idx", "start_sec", "end_sec", "text", "embedding": "[...]" | null}, ...]
create or replace function public.replace_passages(p_sermon_id bigint, p_rows jsonb)
returns integer
language plpgsql
set search_path = public, extensions
as $$
declare
  inserted integer;
begin
  delete from passages where sermon_id = p_sermon_id;
  insert into passages (sermon_id, idx, start_sec, end_sec, text, embedding)
  select p_sermon_id,
         (r->>'idx')::int,
         (r->>'start_sec')::real,
         (r->>'end_sec')::real,
         r->>'text',
         (r->>'embedding')::extensions.vector
  from jsonb_array_elements(p_rows) r;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.replace_passages(bigint, jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.replace_passages(bigint, jsonb) to service_role;
  end if;
end $$;

-- Header numbers and filter dropdowns for the search page.
create or replace function public.sermon_stats()
returns json
language sql
stable
set search_path = public
as $$
  select json_build_object(
    'sermons',     (select count(*) from sermons),
    'transcribed', (select count(*) from sermons where transcript_status = 'done'),
    'first_date',  (select min(published_at) from sermons where transcript_status = 'done'),
    'last_date',   (select max(published_at) from sermons where transcript_status = 'done'),
    'speakers',    coalesce((select json_agg(x order by x.count desc, x.speaker) from (
                     select speaker, count(*) as count from sermons
                     where transcript_status = 'done' and speaker is not null
                     group by speaker) x), '[]'::json),
    'years',       coalesce((select json_agg(y order by y desc) from (
                     select distinct extract(year from published_at)::int as y from sermons
                     where transcript_status = 'done' and published_at is not null) t), '[]'::json)
  );
$$;

grant execute on function public.search_passages(text, extensions.vector, int, int, text, text, int, float, float, float, int) to anon, authenticated;
grant execute on function public.sermon_stats() to anon, authenticated;
