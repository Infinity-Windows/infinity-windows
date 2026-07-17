// Commercial window & door glossary + install procedures + Leitner SRS.
// Ported in full from the Infinity "learn-data.js" content (105 terms, 18 steps).

export interface GlossaryCat {
  id: string;
  label: string;
  color?: string;
}

export interface Term {
  id: string;
  cat: string;
  term: string;
  desc: string;
  links?: string[];
}

export interface ProcStep {
  id: string;
  step: number;
  label: string;
  desc: string;
  branch: "main" | "win" | "door";
}

export const CATS: GlossaryCat[] = [
  {
    "id": "frame",
    "label": "Frame & Materials",
    "color": "#FF9A5C"
  },
  {
    "id": "glazing",
    "label": "Glazing",
    "color": "#7FB7FF"
  },
  {
    "id": "sealing",
    "label": "Sealing & Flashing",
    "color": "#7EDDA5"
  },
  {
    "id": "opening",
    "label": "Openings & Structure",
    "color": "#FFD37F"
  },
  {
    "id": "hardware",
    "label": "Hardware & Operation",
    "color": "#D6A5FF"
  },
  {
    "id": "systems",
    "label": "Commercial Systems",
    "color": "#8CE0DC"
  },
  {
    "id": "install",
    "label": "Installation Methods",
    "color": "#FFA5B8"
  },
  {
    "id": "codes",
    "label": "Codes, Specs & Safety",
    "color": "#C9D67F"
  }
];

export const TERMS: Term[] = [
  {
    "id": "frame",
    "cat": "frame",
    "term": "Frame",
    "desc": "The fixed perimeter assembly — head, jambs and sill — that carries the glass or panel and transfers loads into the wall. In aluminum work, the frame is an extrusion system joined at the corners; if the frame goes in twisted or bowed, nothing that hangs in it will ever run right.",
    "links": [
      "jamb",
      "head",
      "sill",
      "extrusion"
    ]
  },
  {
    "id": "jamb",
    "cat": "frame",
    "term": "Jamb",
    "desc": "The vertical side member of a frame. Jambs take the hinge and lock hardware on doors and the shim pressure on windows. Over-shimming a jamb bows it inward, binding sashes and cracking glass; two snug shim points per side is the rule on aluminum.",
    "links": [
      "shim",
      "reveal"
    ]
  },
  {
    "id": "head",
    "cat": "frame",
    "term": "Head",
    "desc": "The top horizontal member of a frame. Heads must never carry structural load — that is the header's job. A sagging building header that lands on the frame head will rack the unit and jam panels; always check headroom clearance and flash the head LAST so laps shed water.",
    "links": [
      "header",
      "flashtape"
    ]
  },
  {
    "id": "sill",
    "cat": "frame",
    "term": "Sill",
    "desc": "The bottom horizontal member of a frame, and the most water-critical part of any installation. Sills must be dead level — a 1/8\" crown makes a slider drag forever — and always sit over a sill pan or bedding seal so trapped water drains out, not in.",
    "links": [
      "sillpan",
      "weep",
      "level"
    ]
  },
  {
    "id": "mullion",
    "cat": "frame",
    "term": "Mullion",
    "desc": "A vertical or horizontal member that joins two window or door units, or divides a large frame into bays. Structural mullions carry wind load between openings and often need steel reinforcement; verify mullion reinforcing against the shop drawings before assembly.",
    "links": [
      "dp"
    ]
  },
  {
    "id": "muntin",
    "cat": "frame",
    "term": "Muntin",
    "desc": "The small bars that divide a single glass area into a grid pattern. On modern commercial units they are usually decorative — applied to the glass surface or suspended inside the IGU — rather than true structural dividers holding separate panes.",
    "links": [
      "igu"
    ]
  },
  {
    "id": "sash",
    "cat": "frame",
    "term": "Sash",
    "desc": "The operable framed panel that holds the glass in a window — the part that actually moves. Slider sashes ride on rollers, hung sashes ride balances. A sash that drags almost always means a sill or frame problem, not a sash problem.",
    "links": [
      "roller",
      "balance"
    ]
  },
  {
    "id": "thermalbreak",
    "cat": "frame",
    "term": "Thermal Break",
    "desc": "A low-conductivity barrier — poured polyurethane or polyamide strips — separating the interior and exterior halves of an aluminum extrusion. It stops the frame from acting as a cold bridge and condensing water indoors. Never bridge a thermal break with fasteners not designed for it.",
    "links": [
      "extrusion",
      "ufactor"
    ]
  },
  {
    "id": "extrusion",
    "cat": "frame",
    "term": "Extrusion",
    "desc": "An aluminum profile formed by pushing hot billet through a die, giving the frame its shape and screw ports. Extrusions are strong along their length but easy to crush or bow across the section — which is why shim pressure and clamp force matter so much.",
    "links": [
      "thermalbreak"
    ]
  },
  {
    "id": "anodized",
    "cat": "frame",
    "term": "Anodized Finish",
    "desc": "An electrochemical finish that thickens aluminum's natural oxide layer for corrosion resistance and color (clear, bronze, black). Anodizing cannot be touched up in the field like paint — scratches through the coating are permanent, so handle anodized material with softeners on every clamp.",
    "links": [
      "kynar"
    ]
  },
  {
    "id": "kynar",
    "cat": "frame",
    "term": "PVDF / Kynar Coating",
    "desc": "A factory-baked fluoropolymer paint used on commercial aluminum for long-life color. Rated for chalk and fade over decades, but soft — masking tape left in the sun, sealant smears, or dragging units across each other will mark it. Field touch-up kits exist but never match perfectly.",
    "links": [
      "anodized"
    ]
  },
  {
    "id": "weep",
    "cat": "frame",
    "term": "Weep Hole",
    "desc": "A small slotted opening in the sill or glazing pocket that lets water drain out of the frame system. Weeps are part of the engineered drainage path — blocking them with sealant is one of the most common and most damaging field mistakes on commercial frames.",
    "links": [
      "sill",
      "drainage"
    ]
  },
  {
    "id": "flange",
    "cat": "frame",
    "term": "Nailing Flange / Fin",
    "desc": "The perimeter fin on a window frame that laps over the sheathing and takes fasteners and flashing tape. Flanged units are for barrier-wall installs; a bent or cracked flange breaks the water seal and should be straightened or the unit rejected before it goes in.",
    "links": [
      "flangeinstall",
      "flashtape"
    ]
  },
  {
    "id": "igu",
    "cat": "glazing",
    "term": "IGU (Insulated Glass Unit)",
    "desc": "Two or more glass lites sealed around a spacer to trap an insulating airspace. The edge seal is the IGU's life — twisting a unit during handling or setting it without proper blocks breaks the seal and fogs the glass within seasons, a warranty claim every time.",
    "links": [
      "spacer",
      "argon",
      "setblock"
    ]
  },
  {
    "id": "lowe",
    "cat": "glazing",
    "term": "Low-E Coating",
    "desc": "A microscopically thin metallic coating on glass that reflects heat radiation while passing visible light. The coating surface number (e.g. surface 2 vs 3) controls whether it rejects summer heat or keeps winter heat in — installing a lite backwards flips the building's energy behavior.",
    "links": [
      "shgc",
      "ufactor"
    ]
  },
  {
    "id": "argon",
    "cat": "glazing",
    "term": "Argon Fill",
    "desc": "An inert gas heavier than air, sealed into the IGU airspace to slow convective heat transfer and improve U-factor. Argon leaks slowly through a compromised edge seal; a unit that suddenly shows interior condensation likely lost both its argon and its seal.",
    "links": [
      "igu",
      "ufactor"
    ]
  },
  {
    "id": "spacer",
    "cat": "glazing",
    "term": "Spacer",
    "desc": "The perimeter bar separating the lites of an IGU, holding desiccant that keeps the airspace dry. Warm-edge spacers (foam, stainless) cut edge condensation compared to old aluminum boxes. Visible spacer damage or desiccant dust inside the unit means a dead IGU.",
    "links": [
      "igu"
    ]
  },
  {
    "id": "laminated",
    "cat": "glazing",
    "term": "Laminated Glass",
    "desc": "Two lites permanently bonded to a plastic interlayer (PVB/SGP). It cracks but stays in the frame — required for overhead glazing, hurricane openings and security. Laminated is noticeably heavier per square foot; recalc your crew count and lifting gear before the unit shows up.",
    "links": [
      "tempered",
      "safetyglazing"
    ]
  },
  {
    "id": "tempered",
    "cat": "glazing",
    "term": "Tempered Glass",
    "desc": "Heat-treated glass about four times stronger than annealed that shatters into small cubes instead of shards. Required in doors, sidelites, and near-floor glazing. Tempered cannot be cut or drilled after treatment — a wrong-size lite is a reorder, never a field fix. Look for the etched \"bug\" logo in a corner.",
    "links": [
      "annealed",
      "safetyglazing"
    ]
  },
  {
    "id": "annealed",
    "cat": "glazing",
    "term": "Annealed Glass",
    "desc": "Standard float glass with no heat treatment — the default for lites away from hazard locations. It breaks into long dangerous shards and is weaker against thermal stress; deep shading lines or heavy interior curtains against annealed glass can cause thermal cracks.",
    "links": [
      "tempered"
    ]
  },
  {
    "id": "glazingbead",
    "cat": "glazing",
    "term": "Glazing Bead",
    "desc": "The removable stop that retains glass in the frame pocket. Beads snap or screw in and are side-specific — interior-glazed systems mean you can replace glass from inside without scaffolding. Never pry beads with a screwdriver against finished aluminum; use a plastic paddle.",
    "links": [
      "igu"
    ]
  },
  {
    "id": "setblock",
    "cat": "glazing",
    "term": "Setting Block",
    "desc": "A hard rubber block placed at quarter points under the glass edge, transferring the lite's weight into the frame at engineered spots. Missing or mislocated setting blocks concentrate load, walk the glass off-center, and are a classic cause of \"mystery\" glass cracks months later.",
    "links": [
      "igu",
      "glazingbead"
    ]
  },
  {
    "id": "edgedelete",
    "cat": "glazing",
    "term": "Edge Deletion",
    "desc": "Grinding the low-E coating off the glass perimeter before the IGU is sealed so the edge sealant bonds to bare glass. Poor edge deletion at the factory shows up as edge corrosion halos in the field — document it with photos; it is a manufacturer claim, not an install error.",
    "links": [
      "lowe",
      "igu"
    ]
  },
  {
    "id": "vt",
    "cat": "glazing",
    "term": "Visible Transmittance (VT)",
    "desc": "The fraction of visible light a glazing assembly passes, from 0 to 1. Architects balance VT against solar control — a storefront specified at VT 0.6 that ships at 0.4 looks visibly darker and will be rejected. Check the NFRC label against the submittal before installing.",
    "links": [
      "nfrc",
      "shgc"
    ]
  },
  {
    "id": "shgc",
    "cat": "glazing",
    "term": "SHGC (Solar Heat Gain Coefficient)",
    "desc": "The fraction of solar energy that gets through the glazing, 0 to 1 — lower means less summer heat load. Energy code sets maximum SHGC by climate zone and orientation. Mixed-up lites with the wrong SHGC pass visual inspection but fail the energy inspector.",
    "links": [
      "lowe",
      "vt"
    ]
  },
  {
    "id": "ufactor",
    "cat": "glazing",
    "term": "U-Factor",
    "desc": "The rate of heat transfer through the whole assembly — frame plus glass — in BTU/hr·ft²·°F; lower insulates better. Whole-unit U-factor is what codes enforce, which is why thermal breaks and warm-edge spacers matter as much as the glass itself.",
    "links": [
      "thermalbreak",
      "argon",
      "nfrc"
    ]
  },
  {
    "id": "backerrod",
    "cat": "sealing",
    "term": "Backer Rod",
    "desc": "Closed-cell foam rope pushed into the perimeter joint before sealant. It sets the sealant depth to roughly half the joint width and creates the two-sided adhesion a moving joint needs. Sealant without backer rod bonds on three sides and tears itself apart within seasons.",
    "links": [
      "sealant",
      "bondbreaker",
      "tooling"
    ]
  },
  {
    "id": "sealant",
    "cat": "sealing",
    "term": "Sealant",
    "desc": "The elastomeric weather seal — polyurethane or silicone in commercial work — bridging the joint between frame and construction. Polyurethane is paintable and tough; silicone moves more and lasts longer on metal. Joint design, backer rod and tooling matter more than which premium tube you buy.",
    "links": [
      "backerrod",
      "tooling",
      "compatibility"
    ]
  },
  {
    "id": "sillpan",
    "cat": "sealing",
    "term": "Sill Pan",
    "desc": "A waterproof tray — formed metal, PVC, or fluid-applied — under the entire unit sill with upturned back and end dams. Its job is to catch any water that gets past the unit and drain it out over the WRB. The pan is your last line of defense; never screw through its horizontal surface.",
    "links": [
      "enddam",
      "sill",
      "wrb"
    ]
  },
  {
    "id": "flashtape",
    "cat": "sealing",
    "term": "Butyl Flashing Tape",
    "desc": "Self-adhered rubberized tape sealing flanges and rough opening faces. Sequence is law: sill first, jambs overlapping the sill, head last overlapping the jambs, so every lap sheds downhill. Roll every inch — unpressed butyl fishmouths and channels water straight into the wall.",
    "links": [
      "paperflash",
      "flange"
    ]
  },
  {
    "id": "paperflash",
    "cat": "sealing",
    "term": "Paper Flashing",
    "desc": "Asphalt-impregnated kraft flashing used mainly in stucco assemblies, woven into the weather barrier in shingle fashion. Unlike self-adhered tape it relies purely on laps and gravity — a reversed lap behind stucco is invisible at sign-off and a leak lawsuit in two winters.",
    "links": [
      "flashtape",
      "wrb"
    ]
  },
  {
    "id": "wrb",
    "cat": "sealing",
    "term": "WRB (Weather-Resistive Barrier)",
    "desc": "The house wrap or fluid-applied membrane over sheathing that is the wall's actual water plane. Every window flashing detail exists to hand water back onto the WRB. Your flashing must integrate with it — taped to it, lapped under or over per the detail — not just touch it.",
    "links": [
      "sillpan",
      "paperflash",
      "barrier"
    ]
  },
  {
    "id": "enddam",
    "cat": "sealing",
    "term": "End Dam",
    "desc": "The upturned vertical end of a sill pan or sill flashing that stops water from running off the pan's ends into the jamb framing. Missing end dams are the #1 sill pan failure. On metal pans they are soldered or sealed corners; on tape pans, folded and patched.",
    "links": [
      "sillpan"
    ]
  },
  {
    "id": "bondbreaker",
    "cat": "sealing",
    "term": "Bond Breaker",
    "desc": "A tape or the backer rod surface that prevents sealant from adhering to the back of a joint. Sealant must stick to the two joint faces only — three-sided adhesion stops the joint from stretching and shears the sealant off the substrate as the building moves.",
    "links": [
      "backerrod",
      "sealant"
    ]
  },
  {
    "id": "tooling",
    "cat": "sealing",
    "term": "Tooling",
    "desc": "Pressing and shaping the wet sealant bead — with a spatula, not a wet finger on commercial work — to force it against both joint faces and leave a slight hourglass profile. Untooled beads look fine and fail early; tool the same day, before the sealant skins.",
    "links": [
      "sealant",
      "fillet"
    ]
  },
  {
    "id": "fillet",
    "cat": "sealing",
    "term": "Fillet Bead",
    "desc": "A triangular sealant bead bridging two surfaces at roughly 90° — frame to substrate — used where there is no joint gap to fill. Fillets need enough bite on each leg (typically 1/4\" minimum) and still want a bond breaker at the inside corner to allow movement.",
    "links": [
      "tooling",
      "sealant"
    ]
  },
  {
    "id": "capbead",
    "cat": "sealing",
    "term": "Cap Bead",
    "desc": "A finishing bead of sealant run over the top edge of glazing tape or between glass and frame on the exterior, closing the last capillary path. Cap beads on the weather side must be silicone-compatible with the IGU edge seal or they will chemically kill the unit.",
    "links": [
      "compatibility",
      "igu"
    ]
  },
  {
    "id": "compatibility",
    "cat": "sealing",
    "term": "Sealant Compatibility",
    "desc": "Whether a sealant chemically coexists with the materials it touches — IGU edge seals, gaskets, coatings, other sealants. Incompatible combinations de-bond, stain, or dissolve each other. Manufacturers publish compatibility charts; when in doubt, request an adhesion test, not a guess.",
    "links": [
      "sealant",
      "capbead"
    ]
  },
  {
    "id": "drainage",
    "cat": "sealing",
    "term": "Drainage System",
    "desc": "A frame or wall design that accepts that water gets in and manages it out — glazing pockets weeping to the exterior, sill pans draining over the WRB. The installer's job is to keep the path open: no blocked weeps, no sealant dams, laps in the right direction.",
    "links": [
      "weep",
      "barrier"
    ]
  },
  {
    "id": "ro",
    "cat": "opening",
    "term": "Rough Opening (RO)",
    "desc": "The framed hole in the wall that receives the unit, typically 1/2\"–3/4\" larger each way than the frame. Measure width and height at three points each and both diagonals — the RO tells you the truth about the wall before the unit hides it. Fix the opening, never force the frame.",
    "links": [
      "square",
      "shim",
      "header"
    ]
  },
  {
    "id": "kingstud",
    "cat": "opening",
    "term": "King Stud",
    "desc": "The full-height stud running continuously beside the opening from plate to plate, carrying the trimmers and header ends. Anchoring into the king stud gives your jamb screws real structure; missing it and catching only drywall or sheathing is how doors sag out of alignment.",
    "links": [
      "jackstud",
      "header"
    ]
  },
  {
    "id": "jackstud",
    "cat": "opening",
    "term": "Jack / Trimmer Stud",
    "desc": "The shortened stud nailed to the king stud that directly supports the header. Jacks define the RO width and are your primary anchoring substrate at the jambs. Crushed or split jacks under a heavy header telegraph into a pinched opening — check them during RO verification.",
    "links": [
      "kingstud",
      "header"
    ]
  },
  {
    "id": "header",
    "cat": "opening",
    "term": "Header",
    "desc": "The beam over the opening that carries load around it. Headers sag — especially long ones — so check head clearance mid-span; a 1/4\" sag is common and must be shimmed around, never allowed to bear on the frame head, or sliding panels will never latch.",
    "links": [
      "head",
      "deflection"
    ]
  },
  {
    "id": "shim",
    "cat": "opening",
    "term": "Shim",
    "desc": "Tapered or flat packing — composite preferred, cedar acceptable, never under thresholds — used to position the frame in the RO and transfer fastener loads. Rules: at setting points only, snug not tight, always in pairs when tapered so bearing stays flat.",
    "links": [
      "ro",
      "plumb",
      "level"
    ]
  },
  {
    "id": "plumb",
    "cat": "opening",
    "term": "Plumb",
    "desc": "Perfectly vertical in both directions — into/out of the wall plane and side to side. A door hinge jamb must be plumb both ways before anything else is anchored; every operational problem afterward gets measured against it. Check with a 6' level or laser, not a torpedo.",
    "links": [
      "level",
      "square"
    ]
  },
  {
    "id": "level",
    "cat": "opening",
    "term": "Level",
    "desc": "Perfectly horizontal. The sill is the one member where level is non-negotiable — panels roll toward a low corner and locks miss keepers over even 1/8\" of slope. Set the sill level FIRST with shims at engineered points, then build the rest of the install off it.",
    "links": [
      "sill",
      "plumb"
    ]
  },
  {
    "id": "square",
    "cat": "opening",
    "term": "Square",
    "desc": "All corners at 90°, verified by comparing diagonal measurements — equal diagonals mean square. A frame can be plumb and level and still racked out of square. Check diagonals after fastening each side; you can rack a frame with one over-driven screw.",
    "links": [
      "racking",
      "ro"
    ]
  },
  {
    "id": "reveal",
    "cat": "opening",
    "term": "Reveal",
    "desc": "The visible gap between sash/panel and frame, read around all four sides. An even reveal is the quickest field proof that the frame is set true; a reveal that tapers tells you exactly which corner is off and in which direction, before you ever operate the unit.",
    "links": [
      "square",
      "shim"
    ]
  },
  {
    "id": "racking",
    "cat": "opening",
    "term": "Racking",
    "desc": "Distortion of a frame from rectangle to parallelogram, from building movement, bad shimming, or lifting units flat. Racked frames bind panels and pop IGU seals. Window stacks and welded frames must be lifted and braced so they can never rack during handling.",
    "links": [
      "square"
    ]
  },
  {
    "id": "deflection",
    "cat": "opening",
    "term": "Deflection",
    "desc": "Structural movement under load — headers sagging under floors above, slabs creeping over years. Commercial details leave engineered joints (deflection head channels) so the building can move without loading the frame. Never rigidly fasten a frame across a joint designed to move.",
    "links": [
      "header",
      "receptor"
    ]
  },
  {
    "id": "embed",
    "cat": "opening",
    "term": "Embed",
    "desc": "Steel plate or anchor cast into concrete that frames or clips weld/bolt to. Storefront and curtain wall anchoring often lands on embeds — if an embed is missing or misplaced, stop and get engineering direction; drilling adhesive anchors as a substitute needs approval, not improvisation.",
    "links": [
      "anchorschedule",
      "curtainwall"
    ]
  },
  {
    "id": "substrate",
    "cat": "opening",
    "term": "Substrate",
    "desc": "Whatever material your fasteners and sealants actually engage — wood, steel stud, concrete, CMU, sheathing. Every anchor and every sealant has substrate-specific rules. Identifying substrate wrong (screwing into foam-backed panel, sealing to dusty block) is a silent failure.",
    "links": [
      "anchorschedule",
      "compatibility"
    ]
  },
  {
    "id": "panicbar",
    "cat": "hardware",
    "term": "Panic Bar / Exit Device",
    "desc": "The push-to-exit hardware on egress doors that unlatches with body pressure. Prep is cut into the door and frame before install — read the hardware schedule FIRST, because a wrong panic prep cannot be drilled after the frame is set. Budget real time for latch tuning.",
    "links": [
      "hwschedule",
      "egress",
      "strike"
    ]
  },
  {
    "id": "closer",
    "cat": "hardware",
    "term": "Door Closer",
    "desc": "The hydraulic arm that closes and controls the door. Closers have separate adjustments for sweep speed, latch speed, and backcheck — code limits opening force on accessible routes to 5 lbf. Expect 30–40 minutes of tuning per leaf; it is the most fiddled-with hardware on any job.",
    "links": [
      "panicbar",
      "egress"
    ]
  },
  {
    "id": "threshold",
    "cat": "hardware",
    "term": "Threshold",
    "desc": "The floor plate under a door, bridging interior floor to exterior. Set it in a full bed of sealant with sleeved anchors — it is a water entry point and a wear item. ADA limits height to 1/2\" with beveled edges; wood shims under thresholds rot and are never acceptable.",
    "links": [
      "sweep",
      "sealant"
    ]
  },
  {
    "id": "strike",
    "cat": "hardware",
    "term": "Strike Plate",
    "desc": "The frame-mounted plate the latch or panic bolt engages. Strikes are aligned to the hung door, not to a number on a tape — set the door first, then the strike. Misaligned strikes cause the \"slam it twice\" complaint that generates more callbacks than any leak.",
    "links": [
      "panicbar",
      "hinge"
    ]
  },
  {
    "id": "hinge",
    "cat": "hardware",
    "term": "Hinge / Pivot",
    "desc": "The rotation hardware carrying the door's full weight. Commercial doors use ball-bearing butts, continuous gear hinges, or floor pivots. Use the full 3\" screws into structure on the top hinge — the top hinge carries the pull load, and short screws there guarantee a sagging door.",
    "links": [
      "strike",
      "plumb"
    ]
  },
  {
    "id": "roller",
    "cat": "hardware",
    "term": "Roller / Sheave",
    "desc": "The wheeled carriage a sliding panel rides on, height-adjustable through access ports in the panel edge. Rollers are adjusted LAST, after the frame is squared and the sill proven level — adjusting rollers to compensate for a bad sill just relocates the problem.",
    "links": [
      "sash",
      "level"
    ]
  },
  {
    "id": "lockrail",
    "cat": "hardware",
    "term": "Lock Rail",
    "desc": "The vertical panel edge (stile) carrying the lock on a sliding door, engaging a keeper on the jamb. Lock rail alignment is the final test of the whole install: if the frame is square and the sill level, the hooks land; if someone forced the frame, they never will.",
    "links": [
      "roller",
      "square"
    ]
  },
  {
    "id": "astragal",
    "cat": "hardware",
    "term": "Astragal",
    "desc": "The vertical member closing the meeting gap between a pair of doors, carrying weatherstrip and often flush bolts. On egress pairs the astragal choice interacts with panic hardware and code — a removable mullion vs astragal decision belongs to the hardware schedule, not the field.",
    "links": [
      "panicbar",
      "weatherstrip"
    ]
  },
  {
    "id": "sweep",
    "cat": "hardware",
    "term": "Door Sweep",
    "desc": "The flexible seal at the door bottom closing the gap to the threshold. Installed last, after final closer and threshold adjustment. A sweep set too hard makes the closer fail its force limit; too soft and daylight shows. It is a 10-minute item that decides the air-leak test.",
    "links": [
      "threshold",
      "weatherstrip"
    ]
  },
  {
    "id": "operator",
    "cat": "hardware",
    "term": "Operator",
    "desc": "The crank or motor mechanism that opens projecting windows (awning, casement) or automatic doors. Manual operators must be lubed and run through full travel at install; automatic door operators additionally involve sensors, safety zones and an ANSI field inspection.",
    "links": [
      "limitdevice"
    ]
  },
  {
    "id": "limitdevice",
    "cat": "hardware",
    "term": "Limit Device",
    "desc": "A restrictor stopping window sash opening at 4\" where fall hazards exist — required in many occupancies above the first floor. Some are code-mandated and must not be removable without a tool; deleting one to \"make the window open more\" creates direct liability.",
    "links": [
      "operator",
      "fallprotection"
    ]
  },
  {
    "id": "balance",
    "cat": "hardware",
    "term": "Balance",
    "desc": "The spring or block-and-tackle mechanism that counterweights a hung window sash so it stays where you put it. Balances are sized to sash weight — reglazing to heavier laminated glass without rebalancing makes sashes drop, a subtle spec trap on retrofit work.",
    "links": [
      "sash",
      "laminated"
    ]
  },
  {
    "id": "weatherstrip",
    "cat": "hardware",
    "term": "Weatherstripping",
    "desc": "The pile, fin, or bulb seals between operating panels and frames that stop air and water at the moving joints. Weatherstrip is a wear part with a direction — pile too dense adds operating force, worn pile fails air infiltration tests. Replaceable without deglazing on good systems.",
    "links": [
      "sweep",
      "airinfiltration"
    ]
  },
  {
    "id": "storefront",
    "cat": "systems",
    "term": "Storefront",
    "desc": "A non-load-bearing aluminum framing system for ground-floor glass walls and entrances, typically to about 10' tall, stick-assembled in the field. Storefront drains at each horizontal via weeps and is the bread-and-butter commercial system — fast, economical, but weaker against water than curtain wall.",
    "links": [
      "curtainwall",
      "entrance",
      "subsill"
    ]
  },
  {
    "id": "curtainwall",
    "cat": "systems",
    "term": "Curtain Wall",
    "desc": "A framing system that hangs off the building structure floor-to-floor and carries only its own weight plus wind. Distinguished by pressure-equalized drainage, deflection-accommodating anchors, and much higher performance ratings than storefront. Anchoring and joint details are engineered — no field substitutions.",
    "links": [
      "storefront",
      "pressureplate",
      "embed",
      "deflection"
    ]
  },
  {
    "id": "windowwall",
    "cat": "systems",
    "term": "Window Wall",
    "desc": "A glazing system installed between floor slabs — bearing on the slab below, closing to the slab above — rather than hung past them like curtain wall. Cheaper and installed from the floor, but every slab edge joint becomes a critical fire-stopping and waterproofing detail.",
    "links": [
      "curtainwall",
      "receptor"
    ]
  },
  {
    "id": "punched",
    "cat": "systems",
    "term": "Punched Opening",
    "desc": "A discrete window opening in a solid wall — one unit, one hole — as opposed to ribbons or walls of glass. Punched openings live or die on their perimeter flashing details, since every one has four edges of wall interface per unit of glass.",
    "links": [
      "ribbon",
      "ro"
    ]
  },
  {
    "id": "ribbon",
    "cat": "systems",
    "term": "Ribbon Window",
    "desc": "A continuous horizontal band of windows mulled end-to-end across a facade. Ribbons multiply mullion joints and thermal movement — expansion mullions at intervals per the shop drawings are mandatory, and skipping one shows up as buckled covers the first hot summer.",
    "links": [
      "punched",
      "mullion"
    ]
  },
  {
    "id": "stickbuilt",
    "cat": "systems",
    "term": "Stick-Built",
    "desc": "Field assembly method where mullions (sticks) are set one by one and glass follows. Flexible for irregular openings and small crews, but quality depends entirely on field workmanship — every joint is made in the air, so joint sealing discipline is everything.",
    "links": [
      "unitized",
      "storefront"
    ]
  },
  {
    "id": "unitized",
    "cat": "systems",
    "term": "Unitized",
    "desc": "Curtain wall pre-assembled into factory-glazed panels that interlock on the building, craned into place floor by floor. Field labor shifts from assembly to rigging and alignment; the installer's craft becomes setting anchors to millimeter tolerance and protecting gaskets during the mate.",
    "links": [
      "stickbuilt",
      "curtainwall"
    ]
  },
  {
    "id": "pressureplate",
    "cat": "systems",
    "term": "Pressure Plate",
    "desc": "The exterior aluminum bar that clamps glass into a curtain wall mullion through a thermal gasket, hidden by a snap cover. Torque matters — spec is typically 35–50 in-lb at set spacing; over-torquing crushes gaskets and cracks glass, under-torquing leaks air and water.",
    "links": [
      "snapcover",
      "curtainwall"
    ]
  },
  {
    "id": "snapcover",
    "cat": "systems",
    "term": "Snap Cover",
    "desc": "The decorative cap that clips over a pressure plate, giving curtain wall its finished sightline. Covers come in system-specific profiles and finishes — mixing lots mid-elevation shows as color banding. Install after water testing, since they hide the plates you may need to re-torque.",
    "links": [
      "pressureplate"
    ]
  },
  {
    "id": "subsill",
    "cat": "systems",
    "term": "Sub-Sill",
    "desc": "A continuous secondary sill member under storefront framing that collects water from the system above and weeps it out, with end dams at terminations. The sub-sill is storefront's real waterproofing; setting frames without it, or without sealing its splice joints, is the classic storefront leak.",
    "links": [
      "storefront",
      "enddam",
      "sillpan"
    ]
  },
  {
    "id": "receptor",
    "cat": "systems",
    "term": "Receptor / Head Receptor",
    "desc": "A U-shaped perimeter channel the frame slides into, allowing the frame to move within it as the building deflects. Receptors handle slab deflection at window wall heads and big thermal movement on long elevations. The frame must float in the receptor — sealing it rigid defeats it.",
    "links": [
      "deflection",
      "windowwall"
    ]
  },
  {
    "id": "entrance",
    "cat": "systems",
    "term": "Entrance System",
    "desc": "The door leaf, frame, and hardware package within a storefront — medium-stile, wide-stile, all-glass. Entrances concentrate everything hard about the job: traffic, hardware tuning, ADA force limits, egress function, and thresholds. The entrance is where the owner forms their opinion of your work.",
    "links": [
      "storefront",
      "closer",
      "panicbar"
    ]
  },
  {
    "id": "transom",
    "cat": "systems",
    "term": "Transom",
    "desc": "The framed glass area above a door within the same opening. Transom framing must carry the closer reaction loads if a transom bar mounts overhead hardware — a flimsy transom bar with an overhead concealed closer will flex and fail the closer within a year.",
    "links": [
      "entrance",
      "closer"
    ]
  },
  {
    "id": "dryfit",
    "cat": "install",
    "term": "Dry-Fit",
    "desc": "Setting the unit in the opening without sealant to verify fit, reveal, and shim locations, then pulling it back out. The dry-fit is cheap insurance — finding a 3/8\" problem before there is wet sealant in the joint turns a disaster into an adjustment.",
    "links": [
      "ro",
      "reveal"
    ]
  },
  {
    "id": "fullbed",
    "cat": "install",
    "term": "Full Bed of Sealant",
    "desc": "A continuous, void-free sealant bed under a track or threshold, so no water path exists beneath it. Two generous beads squeezed to full contact count; a skip in the bed is a channel. Bottom tracks get bedded and fastened BEFORE the panel ever comes over.",
    "links": [
      "threshold",
      "sealant"
    ]
  },
  {
    "id": "faceseal",
    "cat": "install",
    "term": "Face-Seal",
    "desc": "A weatherproofing strategy relying entirely on the exterior sealant surface — no internal drainage. Simple but unforgiving: one sealant failure is a direct leak. Modern commercial details avoid pure face-seal except where geometry forces it; if you must, joint quality is everything.",
    "links": [
      "barrier",
      "drainage"
    ]
  },
  {
    "id": "barrier",
    "cat": "install",
    "term": "Barrier System",
    "desc": "A wall strategy where one plane (WRB + flashing + flanges) stops all water. Flanged residential-style installs are barrier systems — which is why lap sequence and tape rolling are non-negotiable. Compare drainage systems, which assume some water passes and manage it out.",
    "links": [
      "wrb",
      "faceseal",
      "drainage"
    ]
  },
  {
    "id": "blockframe",
    "cat": "install",
    "term": "Block Frame Install",
    "desc": "Installing a finless frame directly into the opening — masonry, concrete, or a pocket after siding — anchored through the jambs. All waterproofing comes from perimeter sealant joints and pans since there is no flange; joint sizing for backer rod becomes the critical dimension.",
    "links": [
      "flangeinstall",
      "backerrod"
    ]
  },
  {
    "id": "flangeinstall",
    "cat": "install",
    "term": "Flange Install",
    "desc": "Installing via the perimeter nailing fin lapped over sheathing and taped into the WRB. Fast and forgiving in wood construction. Fasten flanges per schedule without over-driving — a dimpled, over-driven flange screw pulls the fin out of plane and wicks water behind the tape.",
    "links": [
      "flange",
      "flashtape",
      "barrier"
    ]
  },
  {
    "id": "brickmold",
    "cat": "install",
    "term": "Brick Mold",
    "desc": "An applied exterior casing profile that covers the gap between frame and masonry or siding. On commercial replacements, brick mold or panning covers the old frame perimeter — it is trim, not waterproofing; the sealant joint behind it still has to be real.",
    "links": [
      "blockframe"
    ]
  },
  {
    "id": "furring",
    "cat": "install",
    "term": "Furring / Packing",
    "desc": "Continuous shim material building out a frame to meet a wall plane, as opposed to point shims. Used where openings are deep or out of plane. Furring must be rot-proof and structural where anchors pass through it — stacked scraps of OSB are not furring.",
    "links": [
      "shim",
      "substrate"
    ]
  },
  {
    "id": "anchorschedule",
    "cat": "install",
    "term": "Anchor Schedule",
    "desc": "The engineered specification of fastener type, size, embedment and spacing for the system — typically every 16\" o.c. into slabs for storefront, specific patterns at jambs. It is calculated from wind load, not preference; \"more screws\" in the wrong place can be as wrong as fewer.",
    "links": [
      "embed",
      "substrate",
      "dp"
    ]
  },
  {
    "id": "perimeterfasten",
    "cat": "install",
    "term": "Perimeter Fastening",
    "desc": "The fastening pattern around the frame per the anchor schedule, installed progressively while re-checking square and operation. Fasten hinge/lock points first on doors, sill setting points on windows; one over-driven perimeter screw can rack a frame you just squared.",
    "links": [
      "anchorschedule",
      "square"
    ]
  },
  {
    "id": "staging",
    "cat": "install",
    "term": "Staging",
    "desc": "Positioning units, glass, and gear at the point of install before work starts — the difference between a 45-minute install and a half-day. Stage per floor plan labels, store units vertical on padded A-frames, and never stage glass where the sun can thermal-shock it against a dark wall.",
    "links": [
      "aframe",
      "liftgear"
    ]
  },
  {
    "id": "aframe",
    "cat": "install",
    "term": "A-Frame Cart",
    "desc": "The angled transport rack that carries glass and framed units on edge, weight on the bottom edge, leaned a few degrees. Units strapped flat rack themselves and pop IGU seals. Load both sides of an A-frame evenly or it becomes a 400-lb tipping hazard in an elevator.",
    "links": [
      "staging",
      "racking"
    ]
  },
  {
    "id": "liftgear",
    "cat": "install",
    "term": "Lift Gear (Cups & Dollies)",
    "desc": "Vacuum cups, glass dollies, and powered manipulators for moving heavy lites and panels. Rated capacity is per cup on clean, dry, flat glass — coatings, dust, or cold cut the rating. Two people minimum over 150 lb, three above the first story: gear supplements crew, never replaces it.",
    "links": [
      "staging",
      "fallprotection"
    ]
  },
  {
    "id": "fgia",
    "cat": "codes",
    "term": "FGIA / AAMA",
    "desc": "The industry body (formerly AAMA) whose standards govern fenestration performance and installation practice — AAMA ratings on products, installation methods like AAMA 2400. When a spec says \"install per AAMA,\" those documents define your lap sequences, joint sizes and tolerances.",
    "links": [
      "astme1105",
      "nfrc"
    ]
  },
  {
    "id": "astme1105",
    "cat": "codes",
    "term": "ASTM E1105 Field Water Test",
    "desc": "The field test where a calibrated spray rack floods the installed unit while a chamber depressurizes the interior — a lab storm aimed at your work. Commercial jobs test the first installs early; a failed E1105 means forensic tear-down, so flash like the rack is coming.",
    "links": [
      "fgia",
      "waterpen",
      "mockup"
    ]
  },
  {
    "id": "nfrc",
    "cat": "codes",
    "term": "NFRC Label",
    "desc": "The certification label stating the unit's tested U-factor, SHGC, and VT. Energy inspectors read these labels against the approved submittals — leave labels on until inspection sign-off, and photograph them per opening; a scraped label can hold up a certificate of occupancy.",
    "links": [
      "ufactor",
      "shgc",
      "submittal"
    ]
  },
  {
    "id": "egress",
    "cat": "codes",
    "term": "Egress",
    "desc": "Code-required escape capability: exit doors that unlatch in one motion without keys or knowledge, and bedroom windows meeting minimum clear-opening sizes. Egress trumps everything — a lock, restrictor, or hardware substitution that compromises egress is illegal regardless of what the owner asked for.",
    "links": [
      "panicbar",
      "limitdevice"
    ]
  },
  {
    "id": "safetyglazing",
    "cat": "codes",
    "term": "Safety Glazing Locations",
    "desc": "Code-defined hazardous locations requiring tempered or laminated glass: doors, sidelites within 24\" of doors, glass under 18\" from the floor, near stairs and tubs. Verify the etched safety bug on every lite in these zones at install — a missing bug is a stop-work item.",
    "links": [
      "tempered",
      "laminated"
    ]
  },
  {
    "id": "fallprotection",
    "cat": "codes",
    "term": "Fall Protection",
    "desc": "OSHA-required protection at 6' or more: guardrails, harnesses with anchors, or restraint systems. Window openings ARE fall hazards the moment the old unit comes out. Anchor points must be rated and independent — a harness tied to the frame you are installing protects nobody.",
    "links": [
      "liftgear",
      "limitdevice"
    ]
  },
  {
    "id": "dp",
    "cat": "codes",
    "term": "Design Pressure (DP)",
    "desc": "The wind load rating a unit is engineered and tested to, in pounds per square foot, positive and negative. The spec's DP drives frame depth, glass thickness, and the anchor schedule. Installing a DP30 unit where DP50 was specified is a structural substitution, not a shrug.",
    "links": [
      "anchorschedule",
      "mullion"
    ]
  },
  {
    "id": "airinfiltration",
    "cat": "codes",
    "term": "Air Infiltration",
    "desc": "Tested air leakage through the closed assembly, in cfm per square foot at a standard pressure. Field failures usually trace to weatherstrip, sweeps, and unsealed frame joints rather than glass. Blower-door era buildings get commissioning tests — your perimeter foam and seals are on the record.",
    "links": [
      "weatherstrip",
      "sweep"
    ]
  },
  {
    "id": "waterpen",
    "cat": "codes",
    "term": "Water Penetration Resistance",
    "desc": "The tested pressure at which wind-driven water gets past the assembly, typically 15–20% of DP. It is why identical-looking systems carry different prices — and why a high-rated system still fails if field joints, end dams and weeps are not built as designed.",
    "links": [
      "astme1105",
      "dp"
    ]
  },
  {
    "id": "mockup",
    "cat": "codes",
    "term": "Field Mock-Up",
    "desc": "The first complete installed assembly, built early and often water-tested, that sets the approved standard for everything after. Get the mock-up perfect and photograph every layer as you build it — it becomes your defense and your training reference for the rest of the job.",
    "links": [
      "astme1105",
      "shopdrawings"
    ]
  },
  {
    "id": "shopdrawings",
    "cat": "codes",
    "term": "Shop Drawings",
    "desc": "The fabricator's detailed drawings of every elevation, joint, anchor, and flashing condition, stamped through the approval chain. Shop drawings outrank memory and habit — when the field condition does not match them, you write an RFI; you do not improvise a detail on a wall.",
    "links": [
      "submittal",
      "mockup",
      "hwschedule"
    ]
  },
  {
    "id": "submittal",
    "cat": "codes",
    "term": "Submittals",
    "desc": "The approved product data, samples and drawings that define what may be installed. If the delivered unit, finish or sealant does not match the approved submittal, installing it transfers liability to whoever put it in the wall. Check deliveries against submittals, not against the PO.",
    "links": [
      "shopdrawings",
      "nfrc"
    ]
  },
  {
    "id": "hwschedule",
    "cat": "codes",
    "term": "Hardware Schedule",
    "desc": "The door-by-door listing of every hinge, closer, panic device, lock function and keying. Read it before frames go in — hardware preps are cut to match it, and a frame set with the wrong prep comes back out. The schedule also decides handing, which the field cannot flip on prepped doors.",
    "links": [
      "panicbar",
      "shopdrawings"
    ]
  },
  {
    "id": "punchlist",
    "cat": "codes",
    "term": "Punch List",
    "desc": "The end-of-job list of defects and incomplete items compiled at walkthrough. Punch work is unpaid rework — every tooled joint, tuned closer, and cleaned label during install is a punch item that never gets written. Crews that photo-document as they go close punch lists in days, not weeks.",
    "links": [
      "mockup",
      "submittal"
    ]
  }
];

export const PROC: ProcStep[] = [
  {
    "id": "pr1",
    "step": 1,
    "label": "Review shop drawings & schedules",
    "desc": "Verify unit numbers, sizes, hardware preps and glazing specs against the plans. Wrong-prep frames come back out of the wall.",
    "branch": "main"
  },
  {
    "id": "pr2",
    "step": 2,
    "label": "Verify the rough opening",
    "desc": "Width and height at 3 points, plumb both ways, diagonals for square, substrate condition. Fix the opening now — never force the frame.",
    "branch": "main"
  },
  {
    "id": "pr3",
    "step": 3,
    "label": "Inspect & stage the unit",
    "desc": "Right unit per schedule, glass intact, flanges straight, hardware prep matches. Stage on A-frames at the opening with lift gear ready.",
    "branch": "main"
  },
  {
    "id": "pr4",
    "step": 4,
    "label": "Prep & flash the opening",
    "desc": "Integrate with the WRB. Sill pan with end dams first — water will get in; give it a way back out.",
    "branch": "main"
  },
  {
    "id": "pr5",
    "step": 5,
    "label": "Dry-fit the unit",
    "desc": "Set without sealant, check reveal and shim points, then pull it. Cheap insurance before anything is wet.",
    "branch": "main"
  },
  {
    "id": "w1",
    "step": 6,
    "label": "Bed & set",
    "desc": "Sealant beads per spec, set the unit, tack it. Sill dead level before anything else.",
    "branch": "win"
  },
  {
    "id": "w2",
    "step": 7,
    "label": "Shim & square",
    "desc": "Shims at setting points, snug not tight, two per side max. Check reveal on all four sides.",
    "branch": "win"
  },
  {
    "id": "w3",
    "step": 8,
    "label": "Fasten per anchor schedule",
    "desc": "Right screws, right spacing. Re-check square after each side — one over-driven screw racks a frame.",
    "branch": "win"
  },
  {
    "id": "w4",
    "step": 9,
    "label": "Flash jambs, then head",
    "desc": "Tape laps shed downhill: jambs over the sill pan, head over the jambs. Roll every inch.",
    "branch": "win"
  },
  {
    "id": "d1",
    "step": 6,
    "label": "Plumb & anchor hinge jamb",
    "desc": "Plumb in BOTH directions, anchored into structure. Everything else on the door references this jamb.",
    "branch": "door"
  },
  {
    "id": "d2",
    "step": 7,
    "label": "Hang & align to the door",
    "desc": "Hang the leaf, then set the strike jamb to the hung door — not to the level. Openings lie; doors don't.",
    "branch": "door"
  },
  {
    "id": "d3",
    "step": 8,
    "label": "Threshold & hardware",
    "desc": "Threshold in a full sealant bed, sleeved anchors. Install and tune closer, panic bar, sweep — budget 40 minutes.",
    "branch": "door"
  },
  {
    "id": "pr6",
    "step": 10,
    "label": "Insulate the perimeter",
    "desc": "Low-expansion foam or backer, no voids. Over-foaming bows jambs — fill in passes.",
    "branch": "main"
  },
  {
    "id": "pr7",
    "step": 11,
    "label": "Backer rod & sealant, tooled",
    "desc": "Rod sets depth at half the joint width. Tool the joint the same day, before it skins.",
    "branch": "main"
  },
  {
    "id": "pr8",
    "step": 12,
    "label": "Adjust & test operation",
    "desc": "Rollers last, locks through full travel, closers within force limits. Even reveal, smooth glide.",
    "branch": "main"
  },
  {
    "id": "pr9",
    "step": 13,
    "label": "Clean, label & log location",
    "desc": "NFRC labels stay on for inspection. Scan the unit QR so Locate knows where it lives now.",
    "branch": "main"
  },
  {
    "id": "pr10",
    "step": 14,
    "label": "Proof photos & teach memo",
    "desc": "Inside, outside, open, closed. Record the voice memo — your experience becomes the next installer's head start.",
    "branch": "main"
  },
  {
    "id": "pr11",
    "step": 15,
    "label": "QC sign-off",
    "desc": "Foreman inspects against the mock-up standard. Points release; callbacks claw back 1.5×.",
    "branch": "main"
  }
];

export type Grade = "again" | "got";

// Leitner intervals per box, in days.
const INTERVALS = [0, 1, 2, 4, 9, 21];

export function nextBox(box: number, grade: Grade): number {
  if (grade === "again") return 0;
  return Math.min(INTERVALS.length - 1, box + 1);
}

export function dueDateFor(box: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + INTERVALS[Math.min(box, INTERVALS.length - 1)]);
  return d.toISOString().slice(0, 10);
}

export interface CardProgress {
  term_id: string;
  box: number;
  due: string; // yyyy-mm-dd
}

/** Build today's deck: priority terms first, then due cards, then new. */
export function buildDeck(
  progress: CardProgress[],
  priorityIds: string[],
  limit = 5,
  today = new Date().toISOString().slice(0, 10),
): Term[] {
  const byId = new Map(progress.map((p) => [p.term_id, p]));
  const priority = new Set(priorityIds);
  const scored = TERMS.map((t) => {
    const p = byId.get(t.id);
    const isNew = !p;
    const isDue = p ? p.due <= today : true;
    // Priority terms always qualify (rank 0); then new, then due; else excluded.
    const rank = priority.has(t.id) ? 0 : isNew ? 2 : isDue ? 3 : 999;
    return { t, rank, due: p?.due ?? "0000" };
  })
    .filter((x) => x.rank < 999)
    .sort((a, b) => a.rank - b.rank || a.due.localeCompare(b.due));
  return scored.slice(0, limit).map((x) => x.t);
}

/** Knowledge score 0-100: how far through the boxes the whole glossary is. */
export function knowledgeScore(progress: CardProgress[]): number {
  if (TERMS.length === 0) return 0;
  const byId = new Map(progress.map((p) => [p.term_id, p]));
  const total = TERMS.reduce((s, t) => s + (byId.get(t.id)?.box ?? 0), 0);
  const max = TERMS.length * (INTERVALS.length - 1);
  return Math.round((total / max) * 100);
}

/** 4-option multiple-choice question from a term (distractors same category). */
export function quizQuestion(term: Term): { prompt: string; options: Term[]; answer: Term } {
  const sameCat = TERMS.filter((t) => t.cat === term.cat && t.id !== term.id);
  const pool = (sameCat.length >= 3 ? sameCat : TERMS.filter((t) => t.id !== term.id));
  const distractors = [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
  const options = [term, ...distractors].sort(() => Math.random() - 0.5);
  return { prompt: term.desc, options, answer: term };
}

// --- Install-sequence "what comes next?" game ---

/** The ordered step list for a window or door install (main + branch). */
export function procSequence(branch: "win" | "door"): ProcStep[] {
  return PROC.filter((p) => p.branch === "main" || p.branch === branch).sort(
    (a, b) => a.step - b.step,
  );
}

/** Pick a step and ask which one comes next, with plausible distractors. */
export function nextStepQuestion(
  branch: "win" | "door",
  rnd: () => number = Math.random,
): { current: ProcStep; options: ProcStep[]; answer: ProcStep } {
  const seq = procSequence(branch);
  const i = Math.floor(rnd() * (seq.length - 1));
  const current = seq[i];
  const answer = seq[i + 1];
  const distractors = seq
    .filter((s) => s.id !== answer.id && s.id !== current.id)
    .sort(() => rnd() - 0.5)
    .slice(0, 2);
  const options = [answer, ...distractors].sort(() => rnd() - 0.5);
  return { current, options, answer };
}
