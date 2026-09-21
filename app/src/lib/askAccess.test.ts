import {describe,it,expect} from 'vitest';
import {askProfileAllowed} from '../../../supabase/functions/_shared/askAccess';
describe('Ask login access is independent of on-site availability',()=>{
 it('allows an off-site internal person whose access remains valid',()=>{
  const profile={active:false,retired_at:null,access_revoked_at:null};
  expect(askProfileAllowed(false,profile,false)).toBe(true);
 });
 it('denies retired, revoked, partner, missing and failed reads',()=>{
  expect(askProfileAllowed(false,{retired_at:'2026-09-01',access_revoked_at:null},false)).toBe(false);
  expect(askProfileAllowed(false,{retired_at:null,access_revoked_at:'2026-09-01'},false)).toBe(false);
  expect(askProfileAllowed(true,{retired_at:null,access_revoked_at:null},false)).toBe(false);
  expect(askProfileAllowed(false,null,false)).toBe(false);
  expect(askProfileAllowed(false,{retired_at:null,access_revoked_at:null},true)).toBe(false);
  expect(askProfileAllowed(null,{retired_at:null,access_revoked_at:null},false)).toBe(false);
 });
});
