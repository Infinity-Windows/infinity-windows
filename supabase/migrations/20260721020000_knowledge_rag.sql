-- Infinity AI knowledge base: a pgvector RAG store for the company's Obsidian
-- vault. Notes are uploaded in-app (supervisor+), chunked, embedded with
-- OpenAI text-embedding-3-small (1536 dims) and retrieved by the `ask` edge
-- function to ground answers alongside live app data.
--
-- Additive + idempotent + graceful-degradation: every object is guarded so
-- this is safe to run on top of live data, and the app never crashes if this
-- migration (or the vector extension) hasn't been applied yet — the chat falls
-- back to the bundled offline brain and the Knowledge page shows a
-- setup-needed state.

create extension if not exists vector;

-- One row per uploaded note (keyed by its vault-relative path). content_hash
-- powers change-detection so a re-upload only re-embeds notes that changed.
create table if not exists knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'vault',
  path text not null,
  title text not null default '',
  content_hash text not null default '',
  active boolean not null default true,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One note occupies one (source, path); re-uploading updates it in place.
create unique index if not exists knowledge_docs_source_path_key
  on knowledge_docs (source, path);
create index if not exists knowledge_docs_active_idx
  on knowledge_docs (active);

-- Token-bounded, overlapping chunks with their embedding vector.
create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references knowledge_docs(id) on delete cascade,
  chunk_index int not null default 0,
  content text not null,
  embedding vector(1536),
  token_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_doc_idx
  on knowledge_chunks (doc_id);

-- Cosine-distance ANN index for fast top-k retrieval. ivfflat keeps build cost
-- low and works well for a single-tenant knowledge base of this size.
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- keep updated_at fresh on doc upserts.
create or replace function set_knowledge_docs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists knowledge_docs_updated_at on knowledge_docs;
create trigger knowledge_docs_updated_at
  before update on knowledge_docs
  for each row execute function set_knowledge_docs_updated_at();

-- Top-k semantic search over active notes. Returns each chunk with its parent
-- note's title/path and a 0..1 cosine similarity, most similar first.
create or replace function match_knowledge_chunks(
  query_embedding vector(1536),
  match_count int default 8,
  min_similarity float default 0.0
)
returns table (
  id uuid,
  doc_id uuid,
  title text,
  path text,
  content text,
  chunk_index int,
  similarity float
)
language sql stable as $$
  select
    c.id,
    c.doc_id,
    d.title,
    d.path,
    c.content,
    c.chunk_index,
    1 - (c.embedding <=> query_embedding) as similarity
  from knowledge_chunks c
  join knowledge_docs d on d.id = c.doc_id
  where d.active
    and c.embedding is not null
    and (1 - (c.embedding <=> query_embedding)) >= min_similarity
  order by c.embedding <=> query_embedding
  limit greatest(1, match_count);
$$;

-- RLS mirrors the trusted-crew pattern used across the install tables: any
-- authenticated user may read (so everyone's chat can retrieve) and write (the
-- UI gates uploading/managing to supervisor+). Reads stay open so the chat
-- never breaks for installers.
alter table knowledge_docs enable row level security;
alter table knowledge_chunks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'knowledge_docs' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on knowledge_docs
      for all to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'knowledge_chunks' and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on knowledge_chunks
      for all to authenticated using (true) with check (true);
  end if;
end;
$$;
