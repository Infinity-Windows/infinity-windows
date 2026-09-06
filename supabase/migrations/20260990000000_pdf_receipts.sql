-- PDF receipts (owner's ask, 2026-09-05): "it needs to be able to do pdf
-- receipts as well."
--
-- A receipt has always been a photo. More and more of them arrive as a PDF —
-- the emailed fuel invoice, the supply-house statement, the Home Depot receipt
-- that came as an attachment — and a phone can now hand one to the app from
-- Files, Drive or the mail app. The phone renders PAGE ONE of that PDF and
-- files it as the receipt's photo (receipts/<id>.jpg), so extract-receipt, the
-- feed thumbnail and the office table all keep working with no change at all.
--
-- ONE COLUMN AND ONE NARROW FUNCTION, for the half that page one loses: the
-- original file. A rendered first page is enough to read an amount off and
-- enough for the office to eyeball, but it is NOT the document a bookkeeper
-- hands an auditor, and pages two and beyond are simply gone from it. So the
-- PDF itself is uploaded beside the picture at receipts/<id>.pdf and recorded
-- here.
--
-- WHY NOT A SIXTH ARGUMENT ON file_receipt. Exactly the reasoning
-- set_receipt_cost_code wrote down in 20260978000000, and one more besides:
--
--   * A new argument list is a DIFFERENT function to Postgres, so it would
--     mean dropping and recreating file_receipt — and any phone still running
--     yesterday's bundle would keep calling the five-argument shape, which
--     would no longer exist.
--   * file_receipt is queued, not called. Its payload sits in IndexedDB on
--     phones right now, minted by a bundle that has never heard of a document.
--     The capture entry has to stay byte-compatible with those, or a receipt
--     snapped in a canyon last night dead-letters when the phone finds signal.
--
-- So the document is a SECOND outbox entry that depends on the first, and this
-- is the writer it calls. Nothing about the capture entry changes.

alter table receipts
  add column if not exists document_path text;

comment on column receipts.document_path is
  'The original file a PDF receipt came from, at install-media/receipts/<id>.pdf. Null on every receipt that was snapped as a photo — which is most of them. photo_path is still the readable image either way: for a PDF that image is page one, rendered on the phone.';


-- ------------------------------------------------------- set_receipt_document
-- Narrow writer, same authorization as update_receipt: the person who filed
-- the receipt, or the office (supervisor+). Called once, by the offline
-- outbox, right after the PDF's bytes land in the bucket.
--
-- Idempotent by nature — writing the same path twice writes the same path — so
-- the queue can retry it blind after a lost reply, which is the whole reason
-- it rides the outbox.
--
-- AND IT CHECKS THE PATH, which is not paperwork. Any signed-in crew member
-- may file a receipt (file_receipt, by design), so any crew member is the
-- uploader of a row they may then write this column on. The string they write
-- is not decoration: the office's "Open original" and the accounting zip
-- export both FETCH whatever it names, in the browser of whoever is looking,
-- and file it into the export beside the receipt's own picture. Left
-- unchecked, `credential-docs/<somebody>/<uuid>.pdf` would put a person's ID
-- document into a bookkeeper's month-end zip labelled as a Shell invoice.
--
-- There is nothing here that needs trusting: one receipt has one original, at
-- one path, and that path is spelled out by the id already being passed in.
create or replace function public.set_receipt_document(
  p_id uuid,
  p_document_path text
)
returns receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_uploader uuid;
  v_path text := nullif(btrim(coalesce(p_document_path, '')), '');
  v_row receipts;
begin
  select uploaded_by into v_uploader from receipts where id = p_id;
  if v_uploader is null then
    raise exception 'no such receipt';
  end if;
  -- The same floor update_receipt and set_receipt_cost_code use.
  if not (v_uid = v_uploader or public.my_role_rank() >= 2) then
    raise exception 'only the uploader or a supervisor can change this receipt'
      using errcode = '42501';
  end if;
  -- The one path this receipt's original may live at — see the header above.
  -- Clearing it (null) stays allowed; pointing it anywhere else never was.
  if v_path is not null
     and v_path <> 'install-media/receipts/' || p_id::text || '.pdf' then
    raise exception 'a receipt''s original file lives at install-media/receipts/<id>.pdf'
      using errcode = '22023';
  end if;

  update receipts set document_path = v_path
   where id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_receipt_document(uuid, text) is
  'Uploader-or-supervisor: records the original PDF a receipt came from. The path is CHECKED to be install-media/receipts/<id>.pdf, so a row cannot be aimed at some other object in the bucket — the office fetches whatever this names. A narrow writer on purpose — see the migration header for why file_receipt''s argument list must not move.';

revoke all on function public.set_receipt_document(uuid, text) from public, anon;
grant execute on function public.set_receipt_document(uuid, text) to authenticated;
