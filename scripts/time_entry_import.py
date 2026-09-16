#!/usr/bin/env python3
"""Reconcile source CSV entries; execute a reviewed batch without exposing payroll in logs.

prepare uses local files only. execute is called by the manual maintenance workflow,
whose encrypted secret holds the reviewed batch. No source files belong in Git.
"""
import argparse
import base64
import csv
from datetime import date, datetime, time, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
import uuid
from zoneinfo import ZoneInfo
import zlib

PROJECT_REF = "czprjcskmzzagdztqonm"
HEADERS = ["Employee Id", "First Name", "Last Name", "Start", "End", "Break", "Total", "Customer", "Project Number", "Project", "Cost Code", "Cost Code Desc.", "Equipment", "Add-Ons", "Description"]
SNAPSHOT_FIELDS = ["id", "profile_id", "project_id", "cost_code_id", "clock_in_at", "clock_out_at", "break_seconds", "status", "note"]

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

def norm(name):
    return " ".join(name.casefold().split())

def instant(value):
    # PostgreSQL omits trailing fractional zeros; older Python versions accept
    # only three or six fractional digits. Pad without changing the instant.
    value = re.sub(r"\.(\d{1,6})(?=[+-]\d{2}:\d{2}$)", lambda m: "." + m[1].ljust(6, "0"), value.replace("Z", "+00:00"))
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("Import timestamps require an explicit time zone")
    return parsed.astimezone(timezone.utc)

def duration(value):
    if not re.fullmatch(r"\d+:\d{2}(?::\d{2})?", value):
        raise ValueError("Invalid duration in source")
    parts = list(map(int, value.split(":")))
    if parts[1] > 59 or (len(parts) == 3 and parts[2] > 59):
        raise ValueError("Invalid duration in source")
    return parts[0] * 3600 + parts[1] * 60 + (parts[2] if len(parts) == 3 else 0)

def local_time(value, zone):
    naive = datetime.fromisoformat(value)
    if naive.tzinfo is not None:
        raise ValueError("Source timestamps must have a confirmed common time zone")
    aware = naive.replace(tzinfo=zone)
    if aware.utcoffset() != naive.replace(tzinfo=zone, fold=1).utcoffset() or aware.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) != naive:
        raise ValueError("Ambiguous or nonexistent daylight-saving source time")
    return aware.astimezone(timezone.utc)

def read_sources(folder, first, last, time_zone):
    zone = ZoneInfo(time_zone)
    sources, files = [], []
    for file in sorted(Path(folder).glob("*.csv")):
        files.append({"file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
        with file.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames != HEADERS:
                raise ValueError("Unexpected source columns")
            for row_number, raw in enumerate(reader, 2):
                if not first <= date.fromisoformat(raw["Start"][:10]) <= last:
                    continue
                start, end = local_time(raw["Start"], zone), local_time(raw["End"], zone)
                breaks, total = duration(raw["Break"]), duration(raw["Total"])
                if end < start or (end - start).total_seconds() - breaks != total:
                    raise ValueError("Source elapsed time, breaks and total disagree")
                name = " ".join([raw["First Name"].strip(), raw["Last Name"].strip()]).strip()
                if not name:
                    raise ValueError("Missing source employee")
                sources.append({"name": name, "start": start.isoformat(), "end": end.isoformat(), "break_seconds": breaks,
                    "net_seconds": total, "key": digest({"original": raw, "timeZone": time_zone}),
                    "source": {"source": "busybusy", "file": file.name, "row": row_number, "timeZone": time_zone, "original": raw}})
    if not sources:
        raise ValueError("No source entries in requested dates")
    if len({s["key"] for s in sources}) != len(sources):
        raise ValueError("Duplicate source entries need review")
    for i, row in enumerate(sources):
        for other in sources[:i]:
            if norm(row["name"]) == norm(other["name"]) and instant(row["start"]) < instant(other["end"]) and instant(row["end"]) > instant(other["start"]):
                raise ValueError("Overlapping source entries need review")
    return sources, files

def uncovered(start, end, existing):
    """Subtract existing intervals without losing fractional seconds or filling real gaps."""
    parts = [(start, end)]
    for a, b in sorted(existing):
        next_parts = []
        for left, right in parts:
            if a >= right or b <= left:
                next_parts.append((left, right))
            else:
                if left < a:
                    next_parts.append((left, a))
                if b < right:
                    next_parts.append((b, right))
        parts = next_parts
    return parts

def prepare(sources, evidence, mappings, first, last, time_zone, files):
    if mappings.get("confirmed") is not True:
        raise ValueError("Employee, project and time-zone mappings need user confirmation")
    people = {p["id"]: p for p in evidence["profiles"]}
    projects = {p["id"]: p for p in evidence["projects"]}
    codes = {c["id"]: c for c in evidence["cost_codes"]}
    created_codes = mappings.get("create_cost_codes", [])
    for code in created_codes:
        if code["id"] in codes or any(c["code"] == code["code"] for c in codes.values()):
            raise ValueError("A proposed historical cost code already exists; refresh mapping")
        codes[code["id"]] = code
    employee_map = {norm(k): v for k, v in mappings["employees"].items()}
    entries, receipt, used_people, used_projects, used_codes = [], [], {}, {}, {}
    existing = [s for s in evidence["shifts"] if s["status"] != "voided"]
    for source in sources:
        profile_id = employee_map[norm(source["name"])]
        person = people[profile_id]
        if person.get("is_test") or person["role"] not in ["installer", "foreman", "lead", "supervisor", "owner", "admin", "big_boss"]:
            raise ValueError("Invalid target employee")
        used_people[profile_id] = {"id": profile_id, "display_name": person["display_name"]}
        original = source["source"]["original"]
        project_id = mappings["projects"][original["Project"]]
        if project_id:
            if projects[project_id].get("is_test"):
                raise ValueError("Cannot import payroll into a test project")
            used_projects[project_id] = {k: projects[project_id][k] for k in ["id", "job_code", "name"]}
        cost_code_id = mappings["cost_codes"][original["Cost Code"]]
        used_codes[cost_code_id] = {k: codes[cost_code_id][k] for k in ["id", "code", "label"]}
        start, end = instant(source["start"]), instant(source["end"])
        overlaps = [s for s in existing if s["profile_id"] == profile_id and instant(s["clock_in_at"]) < end and (not s["clock_out_at"] or instant(s["clock_out_at"]) > start)]
        if any(not s["clock_out_at"] for s in overlaps):
            raise ValueError("An unfinished Forge punch overlaps source time")
        if overlaps and (source["break_seconds"] or any(s["break_seconds"] for s in overlaps)):
            if not (len(overlaps) == 1 and instant(overlaps[0]["clock_in_at"]) == start and instant(overlaps[0]["clock_out_at"]) == end and overlaps[0]["break_seconds"] == source["break_seconds"]):
                raise ValueError("Overlapping break deductions need explicit reconciliation")
        pieces = uncovered(start, end, [(instant(s["clock_in_at"]), instant(s["clock_out_at"])) for s in overlaps])
        added_ids = []
        for left, right in pieces:
            key = digest({"source": source["key"], "profile": profile_id, "start": left.isoformat(), "end": right.isoformat()})
            row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "forge-time-entry:" + key))
            added_ids.append(row_id)
            imported = {**source["source"], "sourceKey": source["key"], "overlapRule": "Keep existing Forge detail; add only uncovered source time", "existingShiftIds": [s["id"] for s in overlaps]}
            entries.append({"id": row_id, "profile_id": profile_id, "project_id": project_id, "cost_code_id": cost_code_id,
                "clock_in_at": left.isoformat(), "clock_out_at": right.isoformat(), "break_seconds": 0 if overlaps else source["break_seconds"],
                "note": original["Description"] or None, "source_import_key": key, "source_import": imported})
        receipt.append({"source": source, "profile_id": profile_id, "project_id": project_id, "overlapped_shift_ids": [s["id"] for s in overlaps], "new_shift_ids": added_ids})
    zone = ZoneInfo(time_zone)
    start = datetime.combine(first, time(), zone).astimezone(timezone.utc)
    end = datetime.combine(last.fromordinal(last.toordinal() + 1), time(), zone).astimezone(timezone.utc)
    snapshots = [{k: s.get(k) for k in SNAPSHOT_FIELDS} for s in existing if s["profile_id"] in used_people and instant(s["clock_in_at"]) < end and (not s["clock_out_at"] or instant(s["clock_out_at"]) > start)]
    payload = {"version": 1, "project_ref": PROJECT_REF, "start": start.isoformat(), "end": end.isoformat(), "time_zone": time_zone,
        "source_files": files, "profiles": list(used_people.values()), "projects": list(used_projects.values()),
        "cost_codes": list(used_codes.values()), "create_cost_codes": created_codes, "expected_shifts": snapshots, "entries": entries}
    validate_payload(payload)
    return payload, receipt

def validate_payload(payload):
    if payload.get("version") != 1 or payload.get("project_ref") != PROJECT_REF:
        raise ValueError("Wrong import version or database")
    if not payload["entries"] or len(payload["entries"]) > 2000:
        raise ValueError("Import must contain 1–2000 new entries")
    if len({r["id"] for r in payload["entries"]}) != len(payload["entries"]) or len({r["source_import_key"] for r in payload["entries"]}) != len(payload["entries"]):
        raise ValueError("Duplicate planned IDs or source keys")
    start, end = instant(payload["start"]), instant(payload["end"])
    if start >= end or (end - start).days > 366:
        raise ValueError("Invalid import range")
    for r in payload["entries"]:
        for key in ["id", "profile_id", "project_id", "cost_code_id"]:
            if r[key] is not None:
                uuid.UUID(r[key])
        left, right = instant(r["clock_in_at"]), instant(r["clock_out_at"])
        if left < start or left >= end or right < left or right > end or not isinstance(r["break_seconds"], int) or not 0 <= r["break_seconds"] <= (right - left).total_seconds():
            raise ValueError("Invalid planned interval or break")
        if not re.fullmatch("[a-f0-9]{64}", r["source_import_key"]):
            raise ValueError("Invalid source key")
        if r["profile_id"] not in {p["id"] for p in payload["profiles"]} or r["cost_code_id"] not in {c["id"] for c in payload["cost_codes"]} or (r["project_id"] and r["project_id"] not in {p["id"] for p in payload["projects"]}):
            raise ValueError("Entry outside reviewed mapping")
        source = r["source_import"]
        if source.get("source") != "busybusy" or set(source.get("original", {})) != set(HEADERS) or source.get("timeZone") != payload["time_zone"]:
            raise ValueError("Original source evidence is incomplete")
    for i, r in enumerate(payload["entries"]):
        for other in payload["entries"][:i]:
            if r["profile_id"] == other["profile_id"] and instant(r["clock_in_at"]) < instant(other["clock_out_at"]) and instant(r["clock_out_at"]) > instant(other["clock_in_at"]):
                raise ValueError("Planned entries overlap")

def sql_for(payload, apply=False):
    validate_payload(payload)
    literal = "'" + canonical(payload).replace("'", "''") + "'::jsonb"
    # This short lock makes the snapshot check and insert indivisible. No existing
    # punch is changed. A busy database fails the import instead of waiting forever.
    return f"""begin;
set local lock_timeout='5s'; set local statement_timeout='30s';
lock table public.time_shifts in share row exclusive mode;
create temporary table forge_import_payload on commit drop as select {literal} as body;
create temporary table forge_import_rows on commit drop as
 select r.* from forge_import_payload p, jsonb_to_recordset(p.body->'entries') as r(
 id uuid, profile_id uuid, project_id uuid, cost_code_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
 break_seconds int, note text, source_import_key text, source_import jsonb);
create temporary table forge_import_result(state text) on commit drop;
do $import$
declare p jsonb; expected_count int; actual_count int; applied_count int;
begin
 select body into p from forge_import_payload;
 select count(*) into expected_count from forge_import_rows;
 select count(*) into applied_count from forge_import_rows r join public.time_shifts s on s.source_import_key=r.source_import_key;
 if applied_count=expected_count then insert into forge_import_result values('already_applied'); return; end if;
 if applied_count>0 then raise exception 'Partial batch or stale plan; reconcile again.'; end if;
 if exists(select 1 from jsonb_to_recordset(p->'profiles') x(id uuid,display_name text)
   left join public.profiles u on u.id=x.id where u.id is null or u.display_name is distinct from x.display_name or u.is_test
   or u.role not in ('installer','foreman','lead','supervisor','owner','admin','big_boss')) then raise exception 'Employee mapping changed.'; end if;
 if exists(select 1 from jsonb_to_recordset(p->'projects') x(id uuid,job_code text,name text)
   left join public.projects j on j.id=x.id where j.id is null or j.job_code is distinct from x.job_code or j.name is distinct from x.name or j.deleted_at is not null or j.is_test) then raise exception 'Project mapping changed.'; end if;
 if exists(select 1 from forge_import_rows r where not exists(select 1 from jsonb_array_elements(p->'profiles') x where x->>'id'=r.profile_id::text)
   or (r.project_id is not null and not exists(select 1 from jsonb_array_elements(p->'projects') x where x->>'id'=r.project_id::text))
   or not exists(select 1 from jsonb_array_elements(p->'cost_codes') x where x->>'id'=r.cost_code_id::text)) then raise exception 'Entry outside reviewed mapping.'; end if;
 select count(*) into actual_count from public.time_shifts s where s.status<>'voided'
   and s.profile_id in(select (x->>'id')::uuid from jsonb_array_elements(p->'profiles') x)
   and s.clock_in_at<(p->>'end')::timestamptz and coalesce(s.clock_out_at,'infinity')>(p->>'start')::timestamptz;
 if actual_count<>jsonb_array_length(p->'expected_shifts') then raise exception 'Timecard snapshot changed; reconcile again.'; end if;
 if exists(select 1 from jsonb_to_recordset(p->'expected_shifts') e(id uuid,profile_id uuid,project_id uuid,cost_code_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_seconds int,status text,note text)
   left join public.time_shifts s on s.id=e.id where s.id is null or
   (s.profile_id,s.project_id,s.cost_code_id,s.clock_in_at,s.clock_out_at,s.break_seconds,s.status,s.note)
     is distinct from (e.profile_id,e.project_id,e.cost_code_id,e.clock_in_at,e.clock_out_at,e.break_seconds,e.status,e.note)) then raise exception 'Timecard detail changed; reconcile again.'; end if;
 if exists(select 1 from forge_import_rows r join public.time_shifts s on s.profile_id=r.profile_id and s.status<>'voided'
   and s.clock_in_at<r.clock_out_at and coalesce(s.clock_out_at,'infinity')>r.clock_in_at) then raise exception 'Import would overlap existing time.'; end if;
 if exists(select 1 from jsonb_to_recordset(p->'create_cost_codes') c(id uuid,code text,label text) join public.cost_codes old on old.id=c.id or old.code=c.code) then raise exception 'Historical cost code changed.'; end if;
 if exists(select 1 from jsonb_to_recordset(p->'cost_codes') c(id uuid,code text,label text) left join public.cost_codes old on old.id=c.id
   where not exists(select 1 from jsonb_array_elements(p->'create_cost_codes') n where n->>'id'=c.id::text)
   and (old.id is null or old.code is distinct from c.code or old.label is distinct from c.label)) then raise exception 'Cost code mapping changed.'; end if;
 insert into public.cost_codes(id,code,label,active) select id,code,label,false from jsonb_to_recordset(p->'create_cost_codes') c(id uuid,code text,label text);
 insert into public.time_shifts(id,profile_id,project_id,cost_code_id,clock_in_at,clock_out_at,break_seconds,status,note,source_import_key,source_import)
   select id,profile_id,project_id,cost_code_id,clock_in_at,clock_out_at,break_seconds,'submitted',note,source_import_key,source_import from forge_import_rows;
 if (select count(*) from public.time_shifts s join forge_import_rows r on s.id=r.id and s.source_import_key=r.source_import_key)<>expected_count then raise exception 'Import did not reconcile.'; end if;
 if exists(select 1 from forge_import_rows r join public.time_shifts s on s.id=r.id where
   (s.profile_id,s.project_id,s.cost_code_id,s.clock_in_at,s.clock_out_at,s.break_seconds,s.note,s.status,s.source_import)
   is distinct from (r.profile_id,r.project_id,r.cost_code_id,r.clock_in_at,r.clock_out_at,r.break_seconds,r.note,'submitted',r.source_import)) then raise exception 'Saved import differs from reviewed plan.'; end if;
 insert into forge_import_result values('validated');
end; $import$;
{'commit' if apply else 'rollback'};
select '{'committed' if apply else 'preview_rolled_back'}' as state;"""

def execute(payload, apply):
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        raise ValueError("Missing maintenance credential")
    request = urllib.request.Request(f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        data=json.dumps({"query": sql_for(payload, apply)}).encode(), method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "Forge-Time-Import/1.0"})
    # Never echo the API error body: a failed SQL constraint can contain payroll.
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.load(response)
    except Exception:
        raise RuntimeError("Import API did not confirm success. Read the saved records before any retry.") from None
    expected_state = "committed" if apply else "preview_rolled_back"
    if not isinstance(result, list) or not any(r.get("state") == expected_state for r in result):
        raise RuntimeError("Import API response needs a private record check before retry.")
    print("Import transaction verified." if apply else "Preview verified and rolled back; no hours changed.")

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    for field in ["sources", "evidence", "mapping", "output", "from-date", "through-date", "time-zone"]:
        prep.add_argument("--" + field, required=True)
    run = sub.add_parser("execute"); run.add_argument("--apply", action="store_true"); run.add_argument("--sha256", required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        first, last = date.fromisoformat(args.from_date), date.fromisoformat(args.through_date)
        sources, files = read_sources(args.sources, first, last, args.time_zone)
        payload, receipt = prepare(sources, json.loads(Path(args.evidence).read_text()), json.loads(Path(args.mapping).read_text()), first, last, args.time_zone, files)
        output = Path(args.output); output.mkdir(parents=True, exist_ok=True); output.chmod(0o700)
        for name, text in [("import-plan.private.json", canonical(payload)), ("source-receipt.private.json", json.dumps(receipt, indent=2)), ("import-payload.private.txt", base64.b64encode(zlib.compress(canonical(payload).encode())).decode())]:
            file = output / name; file.write_text(text); file.chmod(0o600)
        print("Reviewed payload SHA256:", digest(payload))
    else:
        compressed = os.environ.get("FORGE_TIME_IMPORT_PAYLOAD", "")
        raw = zlib.decompress(base64.b64decode(compressed))
        if hashlib.sha256(raw).hexdigest() != args.sha256:
            raise ValueError("Payload does not match the reviewed digest")
        execute(json.loads(raw), args.apply)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Script failures are intentionally generic in shared workflow logs.
        print("Import stopped. Validation or transaction confirmation failed; inspect the private records before any retry.", file=sys.stderr)
        sys.exit(1)
