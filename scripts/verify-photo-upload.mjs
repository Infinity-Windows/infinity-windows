// Replay the real index migrations, then the INSERT ... ON CONFLICT shape
// PostgREST generates. Mocked browser HTTP cannot catch an index mismatch.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
const source = name => readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
await db.exec(`create table time_shifts(id uuid,client_id uuid);
create table attachments(id bigint generated always as identity primary key,client_id uuid,project_id uuid,kind text,storage_path text,created_by text);`);
const original = await source('20260720000000_offline_outbox_idempotency.sql');
await db.exec(original.split('-- 2) clock_in')[0]);
let checks = 0;
const equal = (a,b) => { assert.deepEqual(a,b); checks++; };
const photo = {client_id:'11111111-1111-4111-8111-111111111111',project_id:'22222222-2222-4222-8222-222222222222',kind:'photo',storage_path:'install-media/fixture.jpg',created_by:'fixture@example.test'};
const send = rows => db.query(`insert into attachments (client_id,project_id,kind,storage_path,created_by)
 select client_id,project_id,kind,storage_path,created_by from jsonb_to_recordset($1::jsonb)
 as x(client_id uuid,project_id uuid,kind text,storage_path text,created_by text)
 on conflict(client_id) do update set project_id=excluded.project_id,kind=excluded.kind,storage_path=excluded.storage_path,created_by=excluded.created_by`,[JSON.stringify(rows)]);
await assert.rejects(()=>send([photo]),{code:'42P10'});checks++;
await assert.rejects(()=>send([]),{code:'42P10'});checks++;
await db.exec("insert into attachments (storage_path) values ('legacy-1'),('legacy-2')");
const migration = await source('20261018000000_photo_upload_conflict_index.sql');
await db.exec(migration);
await send([]);checks++;
equal((await db.query('select count(*)::int n from attachments')).rows[0].n,2);
await send([photo]);await send([photo]);
equal((await db.query('select count(*)::int n from attachments where client_id is not null')).rows[0].n,1);
equal((await db.query('select storage_path,created_by from attachments where client_id is not null')).rows[0],{storage_path:photo.storage_path,created_by:photo.created_by});
await db.exec(migration);await send([photo]);
equal((await db.query('select count(*)::int n from attachments')).rows[0].n,3);
await db.exec("insert into attachments(storage_path) values ('legacy-3')");
equal((await db.query('select count(*)::int n from attachments where client_id is null')).rows[0].n,3);
equal((await db.query("select indisunique,indpred is null as unfiltered from pg_index where indexrelid='attachments_client_id_key'::regclass")).rows[0],{indisunique:true,unfiltered:true});
await db.close();
console.log(`${checks} photo upload database checks passed; no network or production writes.`);
