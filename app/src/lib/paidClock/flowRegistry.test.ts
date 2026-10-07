// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
import { publishClockFlow,readClockFlow,subscribeClockFlow } from "./flowRegistry";
import type { NativeClockFlow } from "./flow";
const OWNER="00000000-0000-4000-8000-000000000001",OTHER="00000000-0000-4000-8000-000000000002";
afterEach(()=>{publishClockFlow(null);rememberSignedIn(null);});
describe("one private clock provider",()=>{
  it("shares a flow only for its actual login and clears all generations including ABA",()=>{
    rememberSignedIn({user:{id:OWNER}});
    const flow={ownerId:OWNER,loginGeneration:signInMark().generation,route:"isolated"} as NativeClockFlow;
    const changed=vi.fn(),unsubscribe=subscribeClockFlow(changed);publishClockFlow(flow);
    expect(readClockFlow(OWNER)).toBe(flow);expect(readClockFlow(OTHER)).toBeNull();expect(readClockFlow(null)).toBeNull();
    rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});expect(readClockFlow(OWNER)).toBeNull();
    publishClockFlow(flow);expect(readClockFlow(OWNER)).toBeNull();expect(changed).toHaveBeenCalled();
    unsubscribe();const calls=changed.mock.calls.length;publishClockFlow(null);expect(changed).toHaveBeenCalledTimes(calls);
  });
});
