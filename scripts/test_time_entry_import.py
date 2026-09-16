"""Synthetic payroll reconciliation tests. Never reads real payroll or the network."""
import copy
import csv
from datetime import date
import json
from pathlib import Path
import tempfile
import unittest
import sys
from time_entry_import import HEADERS, read_sources, prepare, instant, uncovered, sql_for, validate_payload

def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"

def fixture():
    raw = dict.fromkeys(HEADERS, "")
    raw.update({"First Name": "Sample", "Last Name": "Installer", "Start": "2026-09-01 07:00", "End": "2026-09-01 15:00", "Break": "00:30", "Total": "07:30", "Project": "Unassigned source job", "Cost Code": "01-07"})
    with tempfile.TemporaryDirectory() as folder:
        with (Path(folder)/"synthetic.csv").open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=HEADERS); writer.writeheader(); writer.writerow(raw)
        sources, files = read_sources(folder, date(2026,9,1), date(2026,9,4), "America/Denver")
    evidence = {"profiles": [{"id": uid(1), "display_name": "Sample Installer", "role": "installer", "is_test": False}],
      "projects": [], "cost_codes": [{"id":uid(2), "code":"1", "label":"Installation"}], "shifts": []}
    mapping = {"confirmed": True, "employees": {"Sample Installer":uid(1)}, "projects": {"Unassigned source job":None}, "cost_codes":{"01-07":uid(2)}}
    return sources, evidence, mapping, files

def planned(sources, evidence, mapping, files):
    return prepare(sources, evidence, mapping, date(2026,9,1), date(2026,9,4), "America/Denver", files)[0]

class ImportTests(unittest.TestCase):
    def test_breaks_and_timezone_and_original_preserved(self):
        s,e,m,f=fixture(); p=planned(s,e,m,f); r=p["entries"][0]
        self.assertEqual(r["clock_in_at"], "2026-09-01T13:00:00+00:00")
        self.assertEqual(r["break_seconds"],1800)
        self.assertEqual(r["source_import"]["original"]["Project"],"Unassigned source job")
        self.assertIsNone(r["project_id"])
        self.assertEqual(planned(s,e,m,f),p)
    def test_requires_confirmed_mapping(self):
        s,e,m,f=fixture(); m["confirmed"]=False
        with self.assertRaises(ValueError): planned(s,e,m,f)
    def test_union_keeps_later_forge_finish_and_fills_earlier_start(self):
        s,e,m,f=fixture(); s[0]["break_seconds"]=0
        e["shifts"]=[{"id":uid(10),"profile_id":uid(1),"project_id":None,"cost_code_id":uid(2),"clock_in_at":"2026-09-01T14:00:00Z","clock_out_at":"2026-09-01T21:00:54.393623Z","break_seconds":0,"status":"approved","note":None}]
        before=copy.deepcopy(e); p=planned(s,e,m,f)
        self.assertEqual(len(p["entries"]),1)
        self.assertEqual(p["entries"][0]["clock_out_at"],"2026-09-01T14:00:00+00:00")
        self.assertEqual(e,before)
    def test_overlap_breaks_need_review(self):
        s,e,m,f=fixture()
        e["shifts"]=[{"id":uid(10),"profile_id":uid(1),"clock_in_at":"2026-09-01T14:00:00Z","clock_out_at":"2026-09-01T20:00:00Z","break_seconds":1800,"status":"approved"}]
        with self.assertRaisesRegex(ValueError,"break deductions"): planned(s,e,m,f)
    def test_unfinished_overlap_refused(self):
        s,e,m,f=fixture(); e["shifts"]=[{"id":uid(10),"profile_id":uid(1),"clock_in_at":"2026-09-01T14:00:00Z","clock_out_at":None,"status":"open"}]
        with self.assertRaisesRegex(ValueError,"unfinished"): planned(s,e,m,f)
    def test_fractional_gaps_and_two_ends(self):
        self.assertEqual(instant("2026-09-01T15:30:45.30943+00:00").microsecond,309430)
        times=list(map(instant,["2026-09-01T13:00Z","2026-09-01T14:00Z","2026-09-01T15:00Z","2026-09-01T15:00:01.168161Z","2026-09-01T20:00Z","2026-09-01T21:00Z"]))
        self.assertEqual(uncovered(times[0],times[5],[(times[1],times[2]),(times[3],times[4])]),[(times[0],times[1]),(times[2],times[3]),(times[4],times[5])])
    def test_bad_mapping_and_duplicate_planned_rows_rejected(self):
        p=planned(*fixture()); p["entries"][0]["cost_code_id"]=uid(9)
        with self.assertRaises(ValueError): validate_payload(p)
        p=planned(*fixture()); p["entries"].append(copy.deepcopy(p["entries"][0]))
        with self.assertRaises(ValueError): validate_payload(p)
    def test_source_validation_and_requested_dates_only(self):
        with tempfile.TemporaryDirectory() as folder:
            raw=fixture()[0][0]["source"]["original"]
            def write(rows):
                with (Path(folder)/"synthetic.csv").open("w",newline="") as f:
                    writer=csv.DictWriter(f,fieldnames=HEADERS);writer.writeheader();writer.writerows(rows)
            before={**raw,"Start":"2026-08-31 07:00","End":"2026-08-31 15:00"}
            write([before,raw]); s,_=read_sources(folder,date(2026,9,1),date(2026,9,4),"America/Denver"); self.assertEqual(len(s),1)
            write([raw,{**raw,"Description":"Different"}])
            with self.assertRaisesRegex(ValueError,"Overlapping source"): read_sources(folder,date(2026,9,1),date(2026,9,4),"America/Denver")
            write([{**raw,"Total":"08:00"}])
            with self.assertRaisesRegex(ValueError,"disagree"): read_sources(folder,date(2026,9,1),date(2026,9,4),"America/Denver")

if __name__ == "__main__":
    if "--sql-fixture" in sys.argv:
        p=planned(*fixture())
        print(json.dumps({"payload":p,"preview":sql_for(p),"apply":sql_for(p,True)}))
    else: unittest.main()
