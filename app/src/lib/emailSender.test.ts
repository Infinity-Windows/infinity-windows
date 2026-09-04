/**
 * The GC email's sender, pinned.
 *
 * This imports the module the edge function itself imports — not a copy — so a
 * change to the fallback chain that broke a brand would fail here in seven
 * seconds instead of arriving as a builder telling us he got mail from the
 * wrong company.
 */
import { describe, expect, it } from "vitest";

import {
  BRAND_NAMES,
  DEFAULT_FROM_ADDRESS,
  brandKey,
  resolveSender,
} from "../../../supabase/functions/_shared/emailSender.ts";

/** Narrow to the success shape and fail loudly rather than silently, so a
 * refusal in a test that expected an address reads as the refusal it is. */
function sent(brand: unknown, settings: Parameters<typeof resolveSender>[1]) {
  const r = resolveSender(brand, settings);
  if (!r.ok) throw new Error(`refused, source ${r.source}`);
  return r;
}

describe("brandKey", () => {
  it("is forge only when the job says forge", () => {
    expect(brandKey("forge")).toBe("forge");
    expect(brandKey("stg")).toBe("stg");
  });

  it("treats a missing or unknown brand as STG, the way the signature does", () => {
    expect(brandKey(null)).toBe("stg");
    expect(brandKey(undefined)).toBe("stg");
    expect(brandKey("")).toBe("stg");
    expect(brandKey("FORGE")).toBe("stg");
    expect(brandKey(7)).toBe("stg");
  });
});

describe("resolveSender — the fallback chain", () => {
  it("uses the brand's own address when the owner has set it", () => {
    const settings = {
      stg: "office@stgwindows.com",
      forge: "office@forgewd.com",
    };
    expect(sent("stg", settings).address).toBe("office@stgwindows.com");
    expect(sent("stg", settings).source).toBe("EMAIL_FROM_STG");
    expect(sent("forge", settings).address).toBe("office@forgewd.com");
    expect(sent("forge", settings).source).toBe("EMAIL_FROM_FORGE");
  });

  it("falls back to the one address that covers both brands", () => {
    const settings = { both: "hello@forgewd.com" };
    expect(sent("stg", settings).address).toBe("hello@forgewd.com");
    expect(sent("forge", settings).address).toBe("hello@forgewd.com");
    expect(sent("forge", settings).source).toBe("EMAIL_FROM");
  });

  it("mixes the two: one brand configured, the other on the shared address", () => {
    const settings = { stg: "office@stgwindows.com", both: "hello@forgewd.com" };
    expect(sent("stg", settings).address).toBe("office@stgwindows.com");
    expect(sent("forge", settings).address).toBe("hello@forgewd.com");
  });

  it("works with nothing set at all — the shipping state", () => {
    expect(sent("stg", {}).address).toBe(DEFAULT_FROM_ADDRESS);
    expect(sent("forge", {}).address).toBe(DEFAULT_FROM_ADDRESS);
    expect(sent("stg", {}).source).toBe("the built-in address");
  });

  it("ignores a setting that is only whitespace", () => {
    // A secret pasted with a stray newline or set to a blank string is not a
    // configured address; treating it as one would mail from nowhere.
    expect(sent("stg", { stg: "   ", both: "hello@forgewd.com" }).address).toBe(
      "hello@forgewd.com",
    );
    expect(sent("forge", { forge: "", both: "" }).address).toBe(DEFAULT_FROM_ADDRESS);
  });

  it("does not let one brand's address leak into the other", () => {
    const settings = { stg: "office@stgwindows.com" };
    expect(sent("forge", settings).address).toBe(DEFAULT_FROM_ADDRESS);
  });
});

describe("resolveSender — the From header", () => {
  it("puts the brand's own name in front of a bare address", () => {
    expect(sent("stg", { stg: "office@stgwindows.com" }).header).toBe(
      "STG Windows & Doors <office@stgwindows.com>",
    );
    expect(sent("forge", { forge: "office@forgewd.com" }).header).toBe(
      "Forge Windows and Doors <office@forgewd.com>",
    );
  });

  it("names the brand even when both fall back to the built-in address", () => {
    expect(sent("stg", {}).header).toBe(`${BRAND_NAMES.stg} <${DEFAULT_FROM_ADDRESS}>`);
    expect(sent("forge", {}).header).toBe(`${BRAND_NAMES.forge} <${DEFAULT_FROM_ADDRESS}>`);
  });

  it("keeps the owner's own wording when the setting already carries a name", () => {
    const r = sent("stg", { stg: "STG Windows <office@stgwindows.com>" });
    expect(r.header).toBe("STG Windows <office@stgwindows.com>");
    expect(r.address).toBe("office@stgwindows.com");
  });

  it("quotes a name that would otherwise read as two addresses", () => {
    // A comma or a full stop in a display name splits the header unless it is
    // quoted — "Forge Windows and Doors, Inc." is exactly the shape that does it.
    const r = sent("forge", { forge: "Forge Windows and Doors, Inc. <office@forgewd.com>" });
    expect(r.header).toBe('"Forge Windows and Doors, Inc." <office@forgewd.com>');
    expect(r.address).toBe("office@forgewd.com");
  });

  it("hands back the bare address as well, which is what a person recognises", () => {
    expect(sent("forge", { forge: "Forge <office@forgewd.com>" }).address).toBe(
      "office@forgewd.com",
    );
  });
});

describe("resolveSender — refusing garbage", () => {
  it("refuses something that is not an address, and names the setting", () => {
    const r = resolveSender("stg", { stg: "the office" });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("EMAIL_FROM_STG");
  });

  it("refuses a mailbox name with no domain", () => {
    expect(resolveSender("forge", { forge: "office@localhost" }).ok).toBe(false);
    expect(resolveSender("forge", { forge: "office" }).ok).toBe(false);
  });

  it("refuses a line break rather than letting it write a second header", () => {
    const r = resolveSender("stg", {
      stg: "office@stgwindows.com\nBcc: someone@else.com",
    });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("EMAIL_FROM_STG");
  });

  it("does not fall through to the next setting when one is wrong", () => {
    // Silently using EMAIL_FROM would send the mail under the wrong name and
    // leave the broken setting undiscovered. Refusing says which one to fix.
    const r = resolveSender("stg", { stg: "nonsense", both: "hello@forgewd.com" });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("EMAIL_FROM_STG");
  });

  it("blames EMAIL_FROM when EMAIL_FROM is the broken one", () => {
    const r = resolveSender("forge", { both: "nonsense" });
    expect(r.ok).toBe(false);
    expect(r.source).toBe("EMAIL_FROM");
  });

  it("cannot refuse the built-in address", () => {
    // If this ever fails, the default itself has been mistyped and every brand
    // stops mailing at once.
    expect(resolveSender("stg", {}).ok).toBe(true);
    expect(resolveSender("forge", {}).ok).toBe(true);
  });
});
