import unittest
from schema_audit import audit

class SchemaAuditTests(unittest.TestCase):
    def test_structure_is_admitted(self):
        r=audit("CREATE TABLE public.jobs(id uuid); ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;")
        self.assertTrue(r["screening_passed"])
    def test_rows_are_refused(self):
        self.assertFalse(audit("INSERT INTO public.jobs VALUES ('00000000-0000-0000-0000-000000000000');")["screening_passed"])
    def test_execute_scheduled_job_is_refused(self):
        self.assertFalse(audit("SELECT cron.schedule('x','* * * * *','select 1');")["screening_passed"])
    def test_function_with_network_side_effect_flagged_without_body(self):
        r=audit("CREATE FUNCTION public.send() RETURNS void LANGUAGE sql AS $$ SELECT net.http_post('https://czprjcskmzzagdztqonm.supabase.co'); $$;")
        self.assertFalse(r["screening_passed"])
        self.assertEqual(r["issues"][0]["object"],"public.send")
        self.assertNotIn("https",str(r["issues"]))
    def test_psql_reconnect_is_refused(self):
        self.assertFalse(audit("\\connect production\nCREATE TABLE public.jobs(id uuid);")["screening_passed"])
    def test_dump_restrict_wrappers_allowed(self):
        self.assertTrue(audit("\\restrict abc123\nCREATE TABLE public.jobs(id uuid);\n\\unrestrict abc123")["screening_passed"])
    def test_arbitrary_select_not_treated_as_schema(self):
        self.assertFalse(audit("SELECT public.mutate();")["screening_passed"])
    def test_unicode_before_network_function_does_not_hide_it(self):
        r=audit("COMMENT ON SCHEMA public IS '☃ →'; CREATE FUNCTION public.send() RETURNS void LANGUAGE sql AS $$ SELECT net.http_post('https://example.invalid'); $$;")
        self.assertFalse(r["screening_passed"])
    def test_url_after_newline_in_function_is_flagged(self):
        r=audit("CREATE FUNCTION public.link() RETURNS text LANGUAGE sql AS $$\nSELECT 'https://app.forgewd.com';\n$$;")
        self.assertFalse(r["screening_passed"])
    def test_url_after_sql_escaped_newline_is_flagged(self):
        r=audit("CREATE FUNCTION public.link() RETURNS text LANGUAGE sql AS $$ SELECT E'\\nhttps://app.forgewd.com'; $$;")
        self.assertFalse(r["screening_passed"])
    def test_dump_search_path_allowed_independent_of_source_position(self):
        self.assertTrue(audit("-- dump\nSET row_security = off; SELECT pg_catalog.set_config('search_path', '', false);")["screening_passed"])
    def test_workshop_link_is_allowed_but_network_call_is_not(self):
        self.assertTrue(audit("CREATE FUNCTION public.link() RETURNS text LANGUAGE sql AS $$ SELECT 'http://127.0.0.1:5278'; $$;",("http://127.0.0.1:5278",))["screening_passed"])
        self.assertFalse(audit("CREATE FUNCTION public.send() RETURNS void LANGUAGE sql AS $$ SELECT net.http_post('http://127.0.0.1:5278'); $$;",("http://127.0.0.1:5278",))["screening_passed"])
    def test_table_as_data_and_network_extension_are_refused(self):
        self.assertFalse(audit("CREATE TABLE public.copied AS SELECT * FROM public.jobs;")["screening_passed"])
        self.assertFalse(audit("CREATE EXTENSION pg_net;")["screening_passed"])
if __name__=="__main__":unittest.main()
