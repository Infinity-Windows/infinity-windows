import {describe,expect,it} from "vitest";
import {buildDirectionsUrls,directionsDestination,hasCoordinates} from "./mapsLinks";
describe("saved job navigation",()=>{
 it("saved coordinates win over address in every provider",()=>{const urls=buildDirectionsUrls("Street label",37.123456789,-113.987654321);expect(new URL(urls.google).searchParams.get("destination")).toBe("37.123456789,-113.987654321");expect(new URL(urls.apple).searchParams.get("daddr")).toBe("37.123456789,-113.987654321");expect(new URL(urls.waze).searchParams.get("ll")).toBe("37.123456789,-113.987654321");expect(new URL(urls.waze).searchParams.has("q")).toBe(false);});
 it("zero works without an address",()=>{expect(directionsDestination(null,0,0)).toBe("0,0");expect(hasCoordinates(0,0)).toBe(true);});
 it("keeps address-only encoding",()=>{const s="1 A&B Street #2";const urls=buildDirectionsUrls(s);expect(new URL(urls.google).searchParams.get("destination")).toBe(s);expect(new URL(urls.waze).searchParams.get("q")).toBe(s);});
 it.each([[null,0],[0,undefined],[NaN,0],[0,Infinity],[91,0],[0,-181]])("bad saved point uses address",(lat,lng)=>{expect(hasCoordinates(lat,lng)).toBe(false);expect(directionsDestination("1 Main",lat,lng)).toBe("1 Main");});
 it("absent point and address give no destination",()=>expect(directionsDestination("—")).toBe(null));
});
