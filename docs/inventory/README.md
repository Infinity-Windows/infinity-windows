# `docs/inventory/`

Where `scripts/supabase-inventory.sh` writes one JSON file per Supabase project
it finds on the account, named `<project-ref>.json`.

The files are not committed yet, because nobody has had a management token since
the merge was scoped. Produce them with:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh
```

Then compare them:

```bash
python3 scripts/supabase-compare.py docs/inventory/*.json
```

**Commit the results.** They are the evidence behind the merge decision, and the
baseline that [`../supabase-merge-plan.md`](../supabase-merge-plan.md) verifies
against afterwards. They contain row counts, column names and bucket names — no
row contents, no keys, no tokens.

One field is worth understanding. A table's `rows` is `null`, not `0`, when the
count could not be read. An earlier audit reported production as clean while it
was 31 tables short, because "no rows" and "no table" both looked like zero.
Everything in this directory keeps those apart.
