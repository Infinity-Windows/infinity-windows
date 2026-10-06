import unittest
from manage import target

class TargetTests(unittest.TestCase):
    def test_only_exact_workshop_is_admitted(self):
        self.assertEqual(target({'supabase_project_ref':'magcghmnbjiukidyalxd','supabase_url':'https://magcghmnbjiukidyalxd.supabase.co'}),'magcghmnbjiukidyalxd')
    def test_production_is_refused(self):
        with self.assertRaises(ValueError):target({'supabase_project_ref':'czprjcskmzzagdztqonm','supabase_url':'https://czprjcskmzzagdztqonm.supabase.co'})
    def test_unknown_target_is_refused(self):
        with self.assertRaises(ValueError):target({'supabase_project_ref':'abcdefghijklmnopqrst','supabase_url':'https://abcdefghijklmnopqrst.supabase.co'})
    def test_url_mismatch_is_refused(self):
        with self.assertRaises(ValueError):target({'supabase_project_ref':'magcghmnbjiukidyalxd','supabase_url':'https://czprjcskmzzagdztqonm.supabase.co'})
if __name__=='__main__':unittest.main()
