-- Toolbox talk library (owner call, 2026-08-11): Horizon Hub's proven talk
-- system, rebuilt for window installation.
--
-- What Horizon got right and we port: a LIBRARY of structured reusable talks
-- (briefing, 6 key points, 3 watch-fors, a stop-work line, and an "I will"
-- pledge that becomes the sign-off checkbox), a weekday -> category rotation
-- so content picks itself, and an admin assignment override per date. What
-- we change: the categories are OUR hazards (heavy units, glass, cuts,
-- heights, jobsite), and the rotation covers WEEKENDS too — Infinity crews
-- work Saturdays, and the sign-in gates check "signed today", so every day
-- must produce a talk.
--
-- The existing flow is untouched: safety_talks stays the daily instance the
-- app reads, toolbox_completions stays the signature record, and every
-- clock-in / task-start gate keeps working unchanged.

-- 1) The library ------------------------------------------------------------

create table if not exists toolbox_talk_library (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  category text not null check (category in ('lifting','glass','cutting','heights','site')),
  position int not null default 0,
  title text not null,
  citation text,
  briefing text not null,
  key_points jsonb not null default '[]'::jsonb,
  watch_for jsonb not null default '[]'::jsonb,
  stop_work_line text,
  pledge text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table toolbox_talk_library enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'toolbox_talk_library' and policyname = 'read talks'
  ) then
    create policy "read talks" on toolbox_talk_library
      for select to authenticated using (true);
  end if;
  -- Content ships via migrations; leads may curate (deactivate/reorder).
  if not exists (
    select 1 from pg_policies
    where tablename = 'toolbox_talk_library' and policyname = 'lead write'
  ) then
    create policy "lead write" on toolbox_talk_library
      for update to authenticated
      using (_is_lead(auth.uid())) with check (_is_lead(auth.uid()));
  end if;
end;
$$;

-- 2) Per-date override ------------------------------------------------------

create table if not exists toolbox_talk_assignments (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references toolbox_talk_library(id) on delete cascade,
  assigned_date date not null,
  assigned_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists toolbox_assignment_one_per_date
  on toolbox_talk_assignments (assigned_date);

alter table toolbox_talk_assignments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'toolbox_talk_assignments' and policyname = 'read assignments'
  ) then
    create policy "read assignments" on toolbox_talk_assignments
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'toolbox_talk_assignments' and policyname = 'lead manage'
  ) then
    create policy "lead manage" on toolbox_talk_assignments
      for all to authenticated
      using (_is_lead(auth.uid())) with check (_is_lead(auth.uid()));
  end if;
end;
$$;

-- 3) The daily instance carries the structured fields -----------------------

alter table safety_talks
  add column if not exists library_slug text,
  add column if not exists category text,
  add column if not exists citation text,
  add column if not exists key_points jsonb,
  add column if not exists watch_for jsonb,
  add column if not exists stop_work_line text,
  add column if not exists pledge text;

-- 4) Rotation: weekday -> category, weekly advance; weekends rotate the
--    whole library so Saturday crews still get a talk (and the gates work).

create or replace function _toolbox_library_for_date(p_date date)
returns toolbox_talk_library
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row toolbox_talk_library;
  v_category text;
  v_count int;
  v_idx int;
begin
  -- An explicit assignment for the date always wins.
  select l.* into v_row
  from toolbox_talk_assignments a
  join toolbox_talk_library l on l.id = a.library_id
  where a.assigned_date = p_date and l.is_active
  limit 1;
  if v_row.id is not null then return v_row; end if;

  v_category := case extract(isodow from p_date)::int
    when 1 then 'lifting'
    when 2 then 'glass'
    when 3 then 'cutting'
    when 4 then 'heights'
    when 5 then 'site'
    else null  -- weekends rotate the whole library
  end;

  if v_category is not null then
    select count(*) into v_count from toolbox_talk_library
      where category = v_category and is_active;
    if v_count = 0 then return null; end if;
    -- Same talk all week within the category; advances each Monday.
    v_idx := ((p_date - date '1970-01-05') / 7) % v_count;
    select * into v_row from toolbox_talk_library
      where category = v_category and is_active
      order by position, slug offset v_idx limit 1;
  else
    select count(*) into v_count from toolbox_talk_library where is_active;
    if v_count = 0 then return null; end if;
    -- Weekend: walk the whole library day by day so Sat != Sun.
    v_idx := (p_date - date '1970-01-05') % v_count;
    select * into v_row from toolbox_talk_library
      where is_active
      order by category, position, slug offset v_idx limit 1;
  end if;
  return v_row;
end;
$$;

create or replace function get_or_create_toolbox_talk_for_date(p_date date)
returns safety_talks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_talk safety_talks;
  v_lib toolbox_talk_library;
  v_body text;
begin
  -- One writer per date; readers queue briefly instead of double-inserting.
  perform pg_advisory_xact_lock(hashtext('toolbox_talk_' || p_date::text));

  select * into v_talk from safety_talks
    where talk_date = p_date
    order by created_at desc limit 1;
  if v_talk.id is not null then return v_talk; end if;

  v_lib := _toolbox_library_for_date(p_date);
  if v_lib.id is null then
    -- Empty library: leave the app on its legacy newest-talk fallback.
    return null;
  end if;

  -- Plain-text body so every legacy reader (snapshot, PDF, old cards)
  -- keeps working without knowing about the structured fields.
  v_body := v_lib.briefing || E'\n\nKey points:\n' ||
    (select string_agg('• ' || x, E'\n') from jsonb_array_elements_text(v_lib.key_points) x) ||
    case when v_lib.stop_work_line is not null
      then E'\n\nStop work: ' || v_lib.stop_work_line else '' end;

  insert into safety_talks
    (title, body, talk_date, library_slug, category, citation,
     key_points, watch_for, stop_work_line, pledge)
  values
    (v_lib.title, v_body, p_date, v_lib.slug, v_lib.category, v_lib.citation,
     v_lib.key_points, v_lib.watch_for, v_lib.stop_work_line, v_lib.pledge)
  returning * into v_talk;
  return v_talk;
end;
$$;

revoke all on function _toolbox_library_for_date(date) from public;
revoke all on function get_or_create_toolbox_talk_for_date(date) from public;
grant execute on function get_or_create_toolbox_talk_for_date(date) to authenticated;

-- 5) The 30-talk window-trade library ---------------------------------------

insert into toolbox_talk_library
  (slug, category, position, title, citation, briefing, key_points, watch_for, stop_work_line, pledge)
values
  ('lift-team-lifts', 'lifting', 1, 'Two-Person Lifts — Somebody Calls the Count', 'OSHA 1926.250 / NIOSH lifting guidance', 'A 6-foot patio slider in vinyl runs 180 pounds; the same unit in fiberglass with tempered glass can pass 250. One person ''muscling it the last few feet'' is how backs end and glass meets concrete. Any unit over 75 pounds or taller than you is a two-person lift, full stop.

One person calls it — lift on three, walk on their pace, set on their count. Decide the route and the set-down point BEFORE hands touch the frame. If you have to talk about where it''s going while you''re holding it, you planned it wrong.', '["Over 75 lb or taller than you = two people, no exceptions", "One caller: they count the lift, set the pace, call the set-down", "Walk the route empty first \u2014 trip hazards, door widths, stair turns", "Grip the frame, never the glass or the nail fin", "Face the direction of travel; side-step, don''t walk backward blind", "Set one corner down first, then roll the unit down \u2014 no finger traps"]'::jsonb, '["Someone repositioning their grip mid-carry without calling a stop", "A carry route with an unswept floor or a closed door in it", "One installer tipping a big unit alone ''just to stage it''"]'::jsonb, 'If a unit starts to go over, LET IT GO and get clear — glass and frames are replaceable, hands and feet are not.', 'I will get a second person on every heavy unit, agree on the route first, and let one voice call the lift.'),
  ('lift-mechanical-aids', 'lifting', 2, 'Carts, Dollies and Suction Lifters — Let the Gear Carry It', 'OSHA 1926.250(a) / manufacturer load ratings', 'The company owns window carts, A-frame dollies and rated suction lifters because a crew that carries everything by hand is a crew that''s worn out by 1 PM and sloppy by 3. Muscle is the backup plan, not the plan.

Every aid has a rated capacity on a sticker. A 265-lb-rated double cup does NOT hold 265 pounds on dusty glass at 40 °F — cold and dirt cut suction hard. Clean the glass, press, check the indicator line, and test with a partial lift before you commit the full weight.', '["Use the cart for anything moving farther than one room", "Check the rating sticker \u2014 derate in cold, dust or on textured glass", "Clean and dry the glass before cupping; press until the indicator holds", "Test-lift an inch and hold 5 seconds before the real lift", "Never walk a suction lifter over anyone''s head or feet", "Strap units to the cart \u2014 a bump at a threshold launches loose glass"]'::jsonb, '["A suction cup with a cracked seal ring or a red indicator showing", "Units stacked loose on a cart with no strap", "Someone carrying by hand because the cart is ''too far away''"]'::jsonb, 'If a suction cup hisses, loses its indicator, or was last inspected who-knows-when, stop and swap it before it drops a unit on someone.', 'I will use the carts and lifters we own, check every rating and seal, and test the grip before trusting it.'),
  ('lift-stairs-elevation', 'lifting', 3, 'Stairs, Ledges and Tight Turns With a Unit in Hand', 'OSHA 1926.250 / manual handling best practice', 'Most dropped units don''t drop on flat ground — they drop on the stairs, at the landing turn, or at the threshold where somebody''s grip gave out mid-step. Stairs double the load on the low person and cut everyone''s vision of their own feet.

Heavy person low, caller high. The low installer sets the pace because they''re carrying more of the weight and walking blind. Break long stair runs at landings — set the unit down, re-grip, breathe, go again. Nobody re-grips on the move.', '["Walk the stairs empty first: measure the turn, clear the treads", "Heavier/stronger installer takes the DOWNHILL side", "The low carrier sets the pace; the high carrier matches it", "Set down and re-grip at every landing \u2014 never mid-flight", "Keep three stair treads visible past the unit or add a spotter", "Gloves with grip, dry hands, no dust on the frame edges"]'::jsonb, '["A carry starting up stairs without the route walked first", "Someone''s fingers going white mid-carry \u2014 grip is failing", "Wet or debris-covered treads on the planned route"]'::jsonb, 'If the grip is failing on the stairs, call it, set the unit on a tread, and re-set — never push through a slipping hold.', 'I will walk stair routes empty first, take set-down breaks at landings, and speak up the second a grip starts to go.'),
  ('lift-staging-storage', 'lifting', 4, 'Staging Units — A Leaning Window Is a Falling Window', 'OSHA 1926.250(b) material storage', 'A window leaned at a lazy angle against a wall is a guillotine on a timer: one bump, one gust through an open doorway, one kid on a occupied remodel, and 200 pounds of glass is moving. Staging is not parking — it''s a controlled hold.

Lean units 10–15 degrees off vertical on padded blocks, glass face to the wall, on an interior wall away from walk paths. Better: the A-frame. Outside, wind owns anything you stage — a 6-foot unit is a sail. Strap outdoor staging or don''t stage outdoors.', '["Lean 10\u201315\u00b0 off vertical \u2014 steeper slides, flatter tips", "Glass faces the wall; frame edge takes the contact", "Pad the floor edge \u2014 concrete chews vinyl and chips glass", "Stage off walk paths, never against a door that opens", "Outdoors: A-frame + strap, or it doesn''t get staged", "Max two units per lean point; no nesting stacks"]'::jsonb, '["A unit staged against a slider or a door someone will use", "Wind picking up with units staged loose outside", "Units nested three deep against each other"]'::jsonb, 'If staged units are anywhere a homeowner, kid or pet can reach them, stop and re-stage before any other work continues.', 'I will stage every unit at the right angle, off the walk paths, strapped when outside, and never leave glass where a bump can move it.'),
  ('lift-back-mechanics', 'lifting', 5, 'Your Back Is the Tool You Can''t Replace', 'NIOSH ergonomics / OSHA General Duty', 'Window installers lose more career years to backs than to any cut. The injury is almost never one heroic lift — it''s the five-hundredth twist with 80 pounds, the reach over a sill, the catch when a unit shifts. Backs fail on interest, not principal.

Load the legs, not the spine: hips back, chest up, unit close to the body. Move your FEET to turn — the lift that hurts people is the twist with load. And warm up: the first lift of a cold morning at 100% is how Monday injuries happen.', '["Hips back, chest up, load close \u2014 no reaching lifts", "Turn with your feet; never twist your spine under load", "First hour of a cold day: slower pace, lighter shares", "Pushing beats pulling \u2014 push carts, don''t drag them", "Above-shoulder work: use a platform, not a stretch", "Pain that lasts past the lift gets reported TODAY, not Friday"]'::jsonb, '["Someone twisting at the waist to pass units along", "A reach-lift over a sill or obstacle instead of repositioning", "A crew member moving stiff and self-medicating through the day"]'::jsonb, 'If your back tweaks mid-lift, set the load down safely and stop — one skipped unit costs nothing; a herniated disc costs a career.', 'I will lift with my legs, turn with my feet, keep loads close, and report strains the day they happen.'),
  ('lift-large-unit-days', 'lifting', 6, 'Big-Unit Days — Panel Lifts, Plates and Extra Hands', 'OSHA 1926.251 rigging / manufacturer instructions', 'Some units don''t get carried — 8-foot sliders, mulled picture-window assemblies, anything glass-first over 300 pounds. Those are equipment days: panel lifters, glass dollies, suction spreader bars, and a crew briefed before the truck opens.

Big-unit days get planned the day before: who''s on which corner, where the lift path runs, what the backup set-down is if something fails. The most dangerous minute is the improvised one — ''we can probably get it'' is the sentence that precedes most crushed fingers.', '["300+ lb or oversize = equipment + a named plan, decided the day before", "Brief every corner: who holds what, who calls, where it sets down", "Rig suction bars per the manufacturer card \u2014 cups, spacing, angle", "Tag line on anything moving above chest height", "Nobody EVER under the unit \u2014 position to the sides", "Abort plan agreed before the lift: where it goes if it goes wrong"]'::jsonb, '["An oversize unit coming off the truck with no plan discussed", "Somebody positioned under a unit being walked up or lifted", "''We can probably get it'' instead of getting the equipment"]'::jsonb, 'If the equipment for a big unit isn''t on site, the unit stays on the truck — stop and reschedule rather than improvise a heavy lift.', 'I will treat oversize units as planned equipment lifts, brief before touching them, and never stand under moving glass.'),
  ('glass-carrying', 'glass', 1, 'Carrying Glass — Never Against Your Body', 'OSHA 1926 Subpart E / ANSI cut-rating standards', 'A sheet of glass that breaks while hugged to your chest opens arteries — chest, wrists, femoral. That''s how glaziers die, and it happens in one second, with no warning, usually with glass that ''felt solid.'' Distance is the whole game.

Carry glass at your side, arms extended, one hand low and one high on the edge, never interlocking fingers around it, never resting it on your shoulder or against your gut. Cut-rated gloves (A4+) and forearm sleeves whenever handling bare glass or broken units.', '["Carry at your side, arms away from your torso", "One hand low-edge, one high-edge \u2014 never wrap fingers around glass", "A4+ cut gloves and sleeves for bare or broken glass", "Two carriers on anything over 3 ft on a side", "Check your path for cords, hoses and offcuts BEFORE picking glass up", "Wind rule: over 20 mph, no exterior sheet carries"]'::jsonb, '["Someone hugging a sash or sheet against their chest to free a hand", "Bare-hand contact on a cut or broken edge", "A glass carry started with the path not cleared"]'::jsonb, 'If glass cracks while you''re carrying it, DROP IT AWAY from you and step back — never try to catch or ride a breaking sheet down.', 'I will keep glass off my body, wear cut-rated gloves and sleeves, and drop breaking glass away rather than catch it.'),
  ('glass-breakage', 'glass', 2, 'When Glass Breaks — Freeze, Then Clean It Like Evidence', 'OSHA 1926.25 housekeeping / first-aid readiness', 'The injury usually isn''t the break — it''s the ten minutes after. Reflex grabs at falling shards, bare-hand cleanup, the sliver in the boot tread that surfaces in the truck. When glass breaks, the reflex we train is FREEZE: hands back, feet still, look before anything moves.

Then clean like it matters: gloves on, big shards lifted by the edges into the glass bucket (never a trash bag — bags slice open on the first shard and the second guy pays), sweep, then shop-vac, then a flashlight pass at floor level. Tempered dice scatter 20 feet farther than you think.', '["When it breaks: freeze, hands back, let it finish falling", "Never grab at falling or tipping glass \u2014 step AWAY", "Cut gloves for cleanup; big shards to the rigid glass bucket", "Sweep, then vacuum, then flashlight at floor level", "Check boot treads before walking into the house or truck", "Tempered scatters far \u2014 sweep the whole room, not the spot"]'::jsonb, '["Broken glass going into a soft trash bag", "Cleanup happening bare-handed ''because it''s just a few pieces''", "A break near a doorway with the scatter path not checked"]'::jsonb, 'If glass breaks anywhere near a homeowner, child or pet, stop all work and secure the area until every fragment is cleaned and verified.', 'I will freeze when glass breaks instead of grabbing, and clean up with gloves, a rigid container, and a flashlight pass.'),
  ('glass-tempered-laminated', 'glass', 3, 'Tempered vs Laminated — Know What You''re Holding', 'IRC R308 safety glazing / 16 CFR 1201', 'Tempered fails ALL AT ONCE — one nick on an edge and the entire lite explodes into dice, in your hands, with a bang. Laminated cracks but hangs together on its interlayer, heavy and floppy like a wet mattress. You handle them differently because they fail differently.

Tempered: protect the edges like they''re the fuse, because they are — never set it on grit, never pry against it, never twist a sash to ''help it in.'' Laminated: expect dead weight that sags and shifts mid-carry, and plan grips for a unit that bends. Check the bug (etched logo) if you''re not sure which you''ve got.', '["Read the bug in the corner \u2014 know tempered from laminated before lifting", "Tempered edges are the fuse: no grit, no pry bars, no edge knocks", "Never twist or rack a tempered sash to force a fit", "Laminated sags \u2014 grip for a unit that flexes, add a second carrier", "Set tempered on padded blocks only, never on concrete", "A chipped tempered edge = a unit that can explode later; flag it, don''t install it"]'::jsonb, '["Someone prying against a tempered edge with a flat bar", "A tempered unit set down on gritty concrete on its edge", "An edge chip being shrugged off on a unit going into a frame"]'::jsonb, 'If you find an edge chip on a tempered lite, stop — that unit can detonate at torque or temperature; it gets flagged and replaced, not installed.', 'I will check what glass I''m holding, protect tempered edges like fuses, and flag chipped units instead of installing them.'),
  ('glass-suction-cups', 'glass', 4, 'Suction Cups Fail — Test Before You Trust', 'Manufacturer load ratings / OSHA General Duty', 'Every installer has a story about the cup that let go. Cold glass, dusty glass, textured or low-E coated surfaces, a hairline in the rubber — suction is physics, and physics doesn''t care that you''re two steps from the frame. When it lets go, 100+ pounds is instantly in one hand.

Ritual, every time: wipe the glass, look at the seal ring, press, pump to the line, then TEST — lift an inch, hold five seconds, watch the indicator. Re-pump on long carries. And keep your feet out from under the glass line, because the cup doesn''t warn you first.', '["Wipe and dry the contact patch before every cup placement", "Inspect the seal ring for nicks and flat spots weekly", "Pump to the indicator line \u2014 partial vacuum is not half strength, it''s none", "Test-lift one inch, hold 5 seconds, then commit", "Re-check indicators mid-task on carries over a minute", "Feet and toes NEVER under the glass line during a cup carry"]'::jsonb, '["An indicator creeping toward red mid-carry", "Cups slapped on dusty or frosty glass without a wipe", "A cup carry with someone''s boot directly under the sheet"]'::jsonb, 'If a cup indicator moves toward red during a carry, get the glass down on the nearest safe surface NOW — do not finish the trip on a dying cup.', 'I will clean, inspect, pump and TEST every suction cup before trusting it, and never let feet sit under carried glass.'),
  ('glass-sash-removal', 'glass', 5, 'Pulling Old Sashes — The Glass You Didn''t Install', 'OSHA 1926 Subpart E / lead-safe work practices (RRP)', 'Demo glass is the sketchiest glass on the job: 40-year-old panes cracked under paint, putty that''s welded to the frame, weight-and-chain sashes that slam when the cord''s cut. You didn''t install it, so you don''t know what it''s hiding — treat every old sash as pre-broken.

Score the paint line, work the sash loose evenly — never hammer a stuck corner while your other hand holds glass. Tape cracked panes in an X before pulling. Old single-pane breaks into daggers, not dice. And pre-1978 homes: that dust is a lead protocol, not just a mess.', '["Treat every old sash as already broken \u2014 gloves and sleeves on", "Tape cracked panes both sides before pulling the sash", "Score paint lines; work corners evenly, no hammering near glass", "Control counterweight sashes \u2014 cut cords with the sash blocked", "Old single-pane breaks into daggers \u2014 carry away from the body, always", "Pre-1978 home: lead-safe rules apply to the dust you''re making"]'::jsonb, '["A stuck sash being hammered while someone''s hand steadies the glass", "Cracked panes coming out untaped", "Demo debris with exposed glass edges piling where people step"]'::jsonb, 'If an old unit is cracked and loaded with stress (paint-bound, racked frame), stop and tape, block and plan the pull — never wrestle live broken glass.', 'I will treat demo sashes as pre-broken, tape cracks before pulling, and follow lead-safe practices in older homes.'),
  ('glass-transport', 'glass', 6, 'Glass on the Truck — Racks, Padding and Straps', 'DOT load securement / OSHA 1926.250', 'A load shift at 45 mph turns unsecured units into a shuffle of breaking glass — and the guy who opens the box door takes the avalanche. Transport damage also seeds later injuries: the hairline from a bouncing tailgate ride becomes the pane that explodes during install.

Units ride vertical on the rack, glass-to-glass with padding between, strapped snug at the frame — never across bare glass. Load heavy first, tall inside. And open the door like the load shifted, because someday it did: stand to the side, crack it, look, then open.', '["Vertical on the rack, never flat \u2014 glass carries load on edge", "Padding between every unit; no glass-on-frame contact", "Straps land on frames, snugged \u2014 never tensioned across glass", "Heavy units low and inboard; check straps at every stop", "Open box doors from the SIDE after any drive", "Inspect every unit coming off the truck \u2014 flag hairlines before install"]'::jsonb, '["Units rattling audibly when the truck moves", "A strap cranked directly across a pane", "Someone swinging the box door open face-on after a highway run"]'::jsonb, 'If the load has shifted in transit, stop and re-secure it from outside the fall path before anyone climbs in the box.', 'I will rack, pad and strap every unit, open the truck like the load moved, and flag transport damage before it becomes an install.'),
  ('cut-utility-knives', 'cutting', 1, 'Utility Knives — This Trade''s Number-One Cut', 'OSHA hand-tool safety / Bureau of Labor Statistics', 'More window installers get stitched up by utility knives than by glass. Scoring flashing tape, trimming shims, cutting foam backer — hundreds of cuts a day, and the one that gets you is the pull-stroke toward your off-hand thumb at 3 PM when you''re tired.

Cut away from your body and your holding hand, every stroke. A DULL blade is the dangerous one — it needs force, and force is what slips. Snap or swap blades the moment they drag. Retract the blade every single time it leaves a cut; a live blade in a pocket or on a sill is a booby trap.', '["Cut AWAY from your body and your off-hand \u2014 reposition instead of reaching", "Dull blades slip: swap the moment the blade drags", "Retract every time the knife leaves your hand or the cut", "Your off-hand stays out of the cut line \u2014 behind, never ahead", "Use self-retracting knives for tape and membrane work", "Blades go in a sharps cup, never loose in a pouch or pocket"]'::jsonb, '["A pull-cut tracking toward the hand holding the work", "A knife lying on a sill with the blade out", "Someone forcing a cut with a visibly worn blade"]'::jsonb, 'If a cut needs so much force that your hand could slip through the line, stop — change the blade or change the tool.', 'I will cut away from myself with a sharp blade, keep my off-hand clear, and retract every blade every time.'),
  ('cut-flashing-metal', 'cutting', 2, 'Tin Snips and Flashing — Sheet Metal Bites Back', 'OSHA 1926 Subpart E / hand-tool safety', 'Cut aluminum coil and steel flashing edges are surgical — they slice through normal gloves on a light brush, and the cut is deep and clean before you feel it. Half this trade''s stitches come from a piece of flashing somebody was holding wrong, or one springing back mid-cut.

Snips in one hand, the WORK held away from the cut line with the other — sheet metal curls and springs as you cut, and the fresh edge whips. Deburr or fold every cut edge that stays on the job. Offcuts go straight to the debris bucket; a flashing scrap on the floor is a razor blade with a delivery route.', '["A4+ cut gloves for ALL coil and flashing work \u2014 no exceptions", "Hold the work away from the cut line; metal springs when it releases", "Fold or deburr cut edges that stay installed", "Offcuts go to the bucket immediately \u2014 never on the floor or sill", "Cut on the brake or bench when possible, not in-hand overhead", "Watch the second edge: the piece IN your hand cuts too"]'::jsonb, '["Someone cutting coil bare-handed ''for a quick trim''", "Flashing offcuts collecting on the floor of the work area", "In-hand cuts happening overhead on a ladder"]'::jsonb, 'If flashing work is happening bare-handed, stop it — one brush with a fresh edge cuts to the tendon.', 'I will glove up for every metal cut, control the spring, and bucket the offcuts before they land on the floor.'),
  ('cut-saws', 'cutting', 3, 'Circular and Recip Saws Around Openings', 'OSHA 1926.300–304 power tools', 'Saws around window openings work in the worst conditions: cutting nail fins overhead, plunge-cutting siding blind, one hand on the ladder. Kickback on a circular saw throws the tool at your thigh; a recip blade grabbing hidden framing throws YOU.

Two hands on the saw, always — if the position needs one hand for balance, the position is wrong; move the ladder. Never defeat a guard, never cut blind into a wall bay without checking for wires and pipes, and let the blade STOP before it leaves the cut. The coasting blade is the one that finds thighs.', '["Two hands on every saw \u2014 reposition instead of one-handing", "Guards work or the saw doesn''t: never pin or remove them", "Check wall bays for wires and plumbing before plunge cuts", "Let blades stop completely before setting the saw down", "Cord routed behind the cut line, never across it", "Eye pro under a face shield for overhead cuts \u2014 chips rain down"]'::jsonb, '["A guard tied back or wedged open", "A one-handed saw cut from a ladder", "A plunge cut going into a bay nobody scanned"]'::jsonb, 'If a cut can''t be made with two hands, guards on, from stable footing — stop and re-set the ladder or bring the work down.', 'I will keep two hands on saws, guards working, check before I plunge, and let blades stop before they leave the cut.'),
  ('cut-grinders-drills', 'cutting', 4, 'Grinders, Cutoff Wheels and Masonry Bits', 'OSHA 1926.303 abrasive wheels / ANSI B7.1', 'Grinders spin a bonded wheel at 11,000 RPM inches from your hand — a wheel shattering at speed is shrapnel, and it happens when wheels are cracked, wrong-rated, or side-loaded. Around windows, add this: sparks and masonry chips land on installed GLASS and etch it permanently.

Ring-test and rate-check every wheel (wheel RPM ≥ tool RPM), guard on, both hands, and let it reach full speed BEFORE touching the work. Shield installed units from spark trails — a $2 drop cloth beats a $600 replacement lite. Masonry drilling into brick sills: that''s silica — wet it or vac it.', '["Wheel rating \u2265 tool RPM; inspect for cracks before mounting", "Guard on, two hands, full speed before contact", "Never side-load a cutoff wheel \u2014 they shatter sideways", "Shield installed glass from the spark trail before grinding", "Masonry cutting/drilling = silica: wet method or shroud + vac", "Wheels stop before the tool sets down; unplug for wheel changes"]'::jsonb, '["A cutoff wheel being used to grind on its side", "Sparks trailing onto an installed unit or a finished floor", "Dry masonry drilling with dust pluming into the room"]'::jsonb, 'If a wheel is cracked, unrated, or the guard is missing, that grinder is down — stop and fix it before it becomes shrapnel.', 'I will check wheels and guards, shield the glass from sparks, and control masonry dust every time.'),
  ('cut-laceration-response', 'cutting', 5, 'Lacerations — Pressure First, Pride Never', 'OSHA 1926.50 first aid / recordkeeping', 'The wrong move after a bad cut is the trade-guy move: wrap it in a rag, tape it, back to work. Glass and metal cuts are deep and clean — they hit tendons and nerves without looking dramatic, and ''I''ll deal with it tonight'' is how hands lose function permanently.

Direct pressure with a clean dressing, elevate, and ASSESS: gaping edges, numbness or tingling past the cut, can''t move the finger, won''t stop in 10 minutes, or anything deep on the palm side of the hand — that''s stitches-or-better, today. Every cut gets reported the shift it happens, even the small ones; the record is what protects you.', '["Direct pressure + elevation first; don''t rinse a gusher, press it", "Numbness, weakness or a gaping edge = medical care NOW", "Palm-side hand cuts and wrist cuts are surgeon territory \u2014 go", "Won''t stop bleeding in 10 minutes of pressure = go", "Know where the first-aid kit is in YOUR truck, restock what you use", "Report every cut the same shift \u2014 no ''toughing it out'' off the record"]'::jsonb, '["A crew member with a taped-up rag hiding a real cut", "Someone flexing a cut finger to ''test it'' instead of getting seen", "An empty slot in the first-aid kit that never gets flagged"]'::jsonb, 'If a cut is deep, numb, gaping, or on the palm side of the hand or wrist, work stops and that person goes for medical care — today, not tonight.', 'I will treat cuts with pressure and honesty, get real care for deep ones, and report every laceration the shift it happens.'),
  ('cut-blade-changes', 'cutting', 6, 'Blade and Bit Changes — Power Gone, Hands Clear', 'OSHA 1926.300(b) / lockout principles for hand tools', 'A saw that cycles during a blade change takes fingers instantly. Batteries make this worse, not better — there''s no cord to see pulled, and a bumped trigger with a hand wrapped around the blade is a life-changing half second.

The rule is mechanical, not mental: battery OFF the tool (not just ''switched off''), cord OUT of the wall, before your fingers go anywhere near a blade, wheel or bit. Change blades with gloves on — a stationary saw blade still slices — and check the arbor''s tight before power comes back.', '["Battery physically removed / cord unplugged BEFORE touching any blade", "Trigger lock is not a safety \u2014 dead power is the safety", "Gloves on for blade handling; stationary blades still cut", "Torque the arbor and test-spin by hand before repowering", "Old blades to the sharps cup, never the open trash", "Same rule for bits, wheels and hole saws \u2014 power gone, hands clear"]'::jsonb, '["A blade change happening with the battery still seated", "Someone clearing a jam with the tool still powered", "Old blades loose in the trash where a hand will find them"]'::jsonb, 'If a tool jams, the battery comes out BEFORE the jam comes out — no exceptions, no matter how quick the fix looks.', 'I will pull the battery or cord before every blade, bit or jam, and keep my hands off blades until the power is physically gone.'),
  ('height-ladder-setup', 'heights', 1, 'Ladder Setup — 4-to-1, Three Points, Right Ladder', 'OSHA 1926.1053 ladders', 'Ladders put more installers on the ground the hard way than anything else on our jobs. It''s never exotic — it''s a ladder on soft mulch, a top rung stood on, an overreach ''just to reach the last screw'' that walks the ladder sideways.

Extension ladders: 4-to-1 angle (toes at the base, arms straight to the rung), 3 feet above the landing, tied or footed. Stepladders: fully spread, spreaders locked, never the top two steps. Three points of contact moving — which means tools ride in the pouch or get roped up, not carried in a climbing hand.', '["Set 4-to-1: stand at the feet, arms straight out should touch the rung", "Feet on solid, level ground \u2014 pads, not mulch, mud or plywood scraps", "Extension tops tied off or footed by a partner", "Never the top step or top two rungs of a step ladder", "Three points climbing \u2014 tools in the pouch or roped up after", "Belt buckle stays between the rails: move the ladder, don''t reach"]'::jsonb, '["A ladder foot sinking into landscaping or mud", "Someone''s belt buckle outside the rail line, reaching", "Climbing with a drill in one hand and trim in the other"]'::jsonb, 'If the ladder can''t be set at the right angle on solid ground, stop — re-position, build the footing, or get the standoff before anyone climbs.', 'I will set every ladder 4-to-1 on solid footing, keep three points climbing, and move the ladder instead of reaching past the rails.'),
  ('height-open-holes', 'heights', 2, 'The Opening IS the Hazard — Guard the Hole', 'OSHA 1926.501(b)(4) holes and wall openings', 'Our trade''s dirty secret: we CREATE fall hazards all day. The moment an old unit comes out of a second-story wall, there''s a hole with a 12-foot drop and no rail, in a room where our own crew, drywallers, and sometimes a homeowner''s kid are walking. OSHA calls a wall opening with a 6-foot drop a guarded hazard — most window jobs just call it Tuesday.

The rule: an opening above 6 feet never sits unattended unguarded. Either the new unit goes in as part of one continuous operation, or the hole gets a barrier — a cleated 2x rail, the old sash screwed back, a braced sheet of ply. ''We''re coming right back'' is what everyone says before the fall.', '["Plan pulls so the new unit goes straight in \u2014 minimize open-hole time", "An open second-story hole never sits unattended \u2014 guard it or watch it", "Barrier options on the truck: rail stock, cleats, screws \u2014 use them", "Interior floor openings and stairwells near the work get the same rule", "Homeowner occupied? The room with the hole gets closed off, told, taped", "Leaning OUT through the opening to work = harness territory, not balance"]'::jsonb, '["An empty second-story opening with nobody in the room", "A crew member leaning out through an opening past their waist", "Kids or homeowners with access to a room with an open hole"]'::jsonb, 'If you have to leave a second-story opening, it gets a physical barrier first — stop and build it, every time, even for a five-minute break.', 'I will treat every opening I create as a fall hazard, guard holes before walking away, and never lean out past my waist unprotected.'),
  ('height-scaffolds', 'heights', 3, 'Baker Scaffolds and Work Platforms', 'OSHA 1926.451–454 scaffolds', 'Bakers roll, and that''s exactly the problem: a scaffold that moves easy moves when you don''t want it to. Casters unlocked, a platform at the wrong height with a milk crate on top, planks half-seated — interior scaffold falls are short but they land on hard floors, tools and window sills.

All four casters LOCKED before feet leave the floor. Platform pins seated, planks fully hooked, no partial decks. Over 4 feet of platform height needs the outriggers or rails per the manufacturer card. And the golden rule of rolling scaffolds: nobody rides — get down, move it, climb again.', '["All four casters locked before anyone climbs", "Planks fully seated and hooked \u2014 no half-decked platforms", "No boxes, buckets or crates on top to gain height", "Follow the manufacturer card for rails/outriggers above 4 ft", "NOBODY rides a rolling scaffold \u2014 down, move, re-climb", "Watch the ceiling line: sprinkler heads and fans at head height"]'::jsonb, '["A scaffold shifting as someone works from it", "A milk crate or bucket stacked on the platform", "Someone surfing the scaffold while a partner pushes it"]'::jsonb, 'If a scaffold needs ''just a little more height'' beyond its platform, stop — get the right scaffold or a ladder, never stack on top.', 'I will lock every caster, deck platforms fully, never stack for height, and never ride a rolling scaffold.'),
  ('height-second-story', 'heights', 4, 'Second-Story Sets — Work the Wall From Inside', 'OSHA 1926.501 fall protection / company install methods', 'The safest second-story install is the one where nobody''s on the outside wall at all. Most units can be set from inside: flash from the interior, tip the unit through, land the fin, screw off from a platform indoors. Every minute on an extension ladder with a unit in hand is the highest-risk minute this company pays for.

When outside work is unavoidable, it''s a planned exception, not a habit: proper ladder or scaffold at the opening, unit ROPED UP separately (nobody climbs carrying glass), and a person stationed inside to receive. Two-story wall + wind + 150-pound unit is a stop-and-rethink combination, always.', '["Default to interior sets \u2014 flash, tip, land and fasten from inside", "Nobody climbs a ladder carrying a unit: rope it, hoist it, or hand it through", "Outside work at height = planned exception with the right platform", "Station a receiver inside before a unit moves at height", "Wind over 20 mph kills exterior second-story sets for the day", "Exterior trim/capping at height: standoff stabilizer + tie the ladder"]'::jsonb, '["A unit going up an extension ladder in someone''s hand", "An exterior set proceeding as the wind picks up", "No receiver inside as glass approaches an opening"]'::jsonb, 'If a second-story unit can''t go in from inside and the exterior setup isn''t right — platform, weather, receiver — stop and re-plan before the unit leaves the ground.', 'I will set from inside whenever possible, rope units instead of carrying them up, and treat exterior height work as a planned exception.'),
  ('height-harness-anchors', 'heights', 5, 'Harnesses and Anchors — When It''s Over 6 Feet', 'OSHA 1926.502 fall protection systems', 'A harness without a real anchor is a costume. Fall protection only works as a system: rated harness, fitted right, on a rated anchor, with clearance below actually calculated. Construction workers die every year wearing harnesses clipped to gutters, vent pipes and ''that beam that looked solid.''

Anchors need 5,000 pounds per person or an engineered system — a screwed-on temporary anchor into two rafters qualifies; a plumbing stack does not. Fit: leg straps snug, dorsal D-ring between the shoulder blades, lanyard short enough that you can''t hit the ground with stretch. Inspect webbing and stitching before every use; any fall retires the gear, period.', '["Over 6 ft on roofs/exterior platforms without rails = harness + anchor", "Anchors: 5,000 lb rated point, installed per its instructions", "Gutters, vents and conduit are NEVER anchors", "Fit check: snug legs, dorsal D between shoulder blades", "Do the clearance math \u2014 a 6-ft lanyard needs ~18 ft to save you", "Inspect before each use; any fall or fray retires the equipment"]'::jsonb, '["A lanyard clipped to a gutter or vent pipe", "A harness with dangling, loose leg straps", "Frayed webbing or a deployed shock pack still in service"]'::jsonb, 'If there''s no legitimate anchor point for work over 6 feet, the work stops until one is installed — improvised anchors are worse than none because they lie to you.', 'I will use a real anchor or not work the edge, fit my harness right, do the clearance math, and retire dropped gear.'),
  ('height-hoisting', 'heights', 6, 'Getting Units and Tools Up — Rope, Don''t Climb-Carry', 'OSHA 1926.1053(b)(21) / material handling at height', 'One hand for the ladder, one for the load, zero for the fall — climb-carrying is the single dumbest common act in this trade. Anything you can''t climb with in a closed pouch gets a different ride up: rope and bucket, hand-line, hoist, or handed through the opening from a platform.

Rigging matters even for a bucket: tie loads so they can''t shift or snag, haul from OFF to the side of the fall line, and nobody stands or walks under a load in motion. Coming down is the same job in reverse — tools thrown down break tools, feet and truces with homeowners.', '["Three points climbing means EMPTY hands \u2014 pouch it or rope it", "Bucket-and-rope for hardware and tools; hand-line for trim stock", "Units go up by hoist, rope or through-the-opening handoff \u2014 never in a climbing hand", "Haul from beside the drop line, never under it", "Nobody below a moving load \u2014 call the area before hauling", "Lower tools down; throwing is for water bottles, empty, underhand"]'::jsonb, '["Someone starting a climb with a caulk gun in hand", "A helper standing at the ladder base under a hauling bucket", "Trim stock being thrown down to the lawn"]'::jsonb, 'If a load is going up or down a ladder in someone''s hand, stop the climb — rig a line and do it right.', 'I will climb with empty hands, rope loads beside the fall line, and keep everyone out from under anything in motion.'),
  ('site-ppe-minimums', 'site', 1, 'PPE for Window Crews — Hands, Eyes, Feet', 'OSHA 1926 Subpart E / ANSI Z87.1, ANSI/ISEA 105', 'Our trade''s PPE isn''t the hard-hat poster from a highway job — our injuries are hands, eyes and feet. Glass and coil steel demand cut-rated gloves; grinding, drilling and pot-shot glass chips demand Z87 eyes; a dropped sash finds toes with supernatural accuracy.

Minimums on every Infinity job: ANSI A4+ cut gloves whenever glass or sheet metal is in hand, Z87.1 safety glasses from first tool to last, safety-toe boots always. Add the extras when the task calls: face shield over glasses for grinding, sleeves for glass carries and demo, knee pads for sill work — your knees are on concrete 200 days a year.', '["A4+ cut gloves in hand-contact with glass, coil or flashing", "Z87.1 eyes on from first cut to last cleanup", "Safety-toe boots on site, laced \u2014 no sneaker days", "Face shield OVER glasses for grinding and overhead drilling", "Cut sleeves for glass carries, demo and broken-unit cleanup", "Knee pads for sill and floor work \u2014 protect the joints you keep"]'::jsonb, '["Bare hands on a glass or metal edge ''for feel''", "Glasses parked on a hat brim during a dusty cut", "A crew member limping around a dropped-something in soft shoes"]'::jsonb, 'If the PPE for the task isn''t on site — cut gloves, eye pro, the shield — stop that task until it is; skin grows back slower than schedules slip.', 'I will wear cut gloves with glass and metal, keep Z87 eyes on through cleanup, and match the extra PPE to the task.'),
  ('site-silica-dust', 'site', 2, 'Silica — The Dust That Follows You Home', 'OSHA 1926.1153 respirable crystalline silica', 'Cutting a brick sill, grinding stucco back, drilling anchors into concrete — that visible puff is respirable crystalline silica, and it scars lungs permanently. Silicosis doesn''t announce itself on the job; it shows up years later, and there''s no cure, only prevention you either did or didn''t do.

OSHA''s rule is simple where we work: masonry cutting/grinding/drilling gets water or a shrouded vacuum, plus an N95 minimum for short tasks (half-face P100 for longer). Never dry-sweep the dust — wet it or vac it. Indoors, that dust settles on the family''s floor and furniture; containment is part of the job.', '["Wet-cut or shroud-and-vac ALL masonry, stucco and fiber-cement work", "N95 minimum for short tasks; half-face P100 for repeated cuts", "Never dry-sweep silica dust \u2014 wet it down or HEPA-vac it", "Indoors: plastic off the room, vac the settle, wipe the sills", "Position upwind outdoors; keep the crew out of the plume", "Blades and bits for masonry stay matched to a dust method"]'::jsonb, '["A dry cut into brick with dust pluming into the air", "Someone dry-sweeping a masonry work area", "A dusty room being handed back to a homeowner uncleaned"]'::jsonb, 'If a masonry cut is about to happen with no water and no vac shroud, stop — set up the dust control first; lungs don''t get a second pass.', 'I will control masonry dust with water or a shrouded vac, wear the right respirator, and never dry-sweep silica.'),
  ('site-sealants-chemicals', 'site', 3, 'Sealants, Foams and Solvents — Read the Can', 'OSHA 1910.1200 HazCom / product SDS', 'The chemistry on a window truck is real: polyurethane foams carry isocyanates that can sensitize you for life (one bad exposure and every future whiff triggers asthma), solvent cleaners are flammable and headache-in-a-can, and some sealants demand ventilation the label assumes you read.

Know three things about every product you gun or spray: what it does to skin, what it does to lungs, and what kills it (water? solvent?). Nitrile gloves for foam and sealant work — cured foam on skin is a peeling job for a week. Ventilate interior application: crack the opening, run a fan, give the room air the label asks for.', '["Read the label/SDS once for every product you use regularly", "Nitrile gloves for foam, sealant and solvent contact", "Ventilate interior foam and solvent work \u2014 open air, fan on", "Isocyanate foam: no smoking near it, respirator for heavy use", "Eyes: goggles when overhead-gunning \u2014 sealant drips blind", "Solvent rags spread out to dry or in a sealed metal can \u2014 pile = fire"]'::jsonb, '["Foam being gunned overhead with no eye protection", "A closed room fogged with solvent smell and no airflow", "A pile of solvent rags left in a warm truck"]'::jsonb, 'If a product is causing dizziness, burning eyes or a headache, stop, get to air, and fix the ventilation before finishing the task.', 'I will know what''s in my caulk gun, glove and ventilate for it, and never leave solvent rags piled to cook.'),
  ('site-housekeeping', 'site', 4, 'Housekeeping — Cords, Offcuts and the Path You Walk', 'OSHA 1926.25 housekeeping / 1926.416 cords', 'Nobody plans the trip over a cord while carrying a sash — but the cord was there all morning, and everybody stepped over it forty times until the one time with 150 pounds of glass in hand. Our injuries compound: a trip that''s a bruise empty-handed is a laceration-plus-fall carrying a unit.

The standard: the CARRY PATH stays clear at all times — cords along walls or overhead, hoses flagged, offcuts and shims bucketed as they''re made, broken glass never waits. Ten minutes of cleanup at lunch and at pack-out isn''t housekeeping theater; it''s the cheapest injury prevention we buy. The site should look plannable at all times, because it is.', '["The carry path gets cleared BEFORE any unit moves", "Cords run along walls or overhead, never across doorways", "Offcuts, shims and packaging bucketed as they''re made", "Broken glass cleaned immediately \u2014 it never ''waits until lunch''", "Drop cloths flat and taped \u2014 a wrinkled cloth is a trip hazard too", "Ten-minute resets at lunch and pack-out, every job, every day"]'::jsonb, '["A cord crossing the path between the truck and the opening", "Offcut piles growing where carriers will walk", "A drop cloth bunched at a doorway threshold"]'::jsonb, 'If the carry path isn''t clear, glass doesn''t move — stop and clear it first, every carry, even the short ones.', 'I will keep carry paths clear, bucket debris as I make it, and treat cleanup as part of the install, not after it.'),
  ('site-weather', 'site', 5, 'Heat, Cold and Wind — The Wall Doesn''t Care', 'OSHA General Duty / NWS heat index guidance', 'Window work happens ON the envelope — full sun bouncing off glass and light siding, wind funneling around corners, winter cold stiffening hands that need fine motor control for glass. Weather isn''t background; it changes what''s safe to do by the hour.

Heat: water every 15–20 minutes, shade breaks scaled to the heat index, watch each other for confusion — the person overheating is the last to know. Cold: numb hands drop glass and slip on blades, so rotate warm-up breaks and keep grip gloves dry. Wind: over 20 mph, big exterior sheet and second-story sets are done for the day — a 6-foot unit is a sail you can''t argue with.', '["Hydrate every 15\u201320 min in heat; electrolytes past 90 \u00b0F index", "Buddy-check in heat: confusion and no-sweat are 911 signs", "Cold: rotate warm-up breaks \u2014 numb hands don''t hold glass", "Wind over 20 mph stops exterior sheet carries and high sets", "Sun on glass burns skin and eyes \u2014 sunscreen and shaded staging", "Storms: glass work stops before the front hits, not during"]'::jsonb, '["A crew member gone quiet and confused in afternoon heat", "Bare or soaked gloves on glass work in the cold", "An exterior set continuing as gusts pick up"]'::jsonb, 'If wind, heat or cold has changed what your hands or the glass will reliably do, stop that task and re-plan — the wall will still be there in an hour.', 'I will hydrate, buddy-check, warm up numb hands, and let wind cancel high glass work without arguing.'),
  ('site-stop-work', 'site', 6, 'Stop-Work Authority — Use It', 'OSHA whistleblower protections / company policy', 'Every person on an Infinity job — first-week installer included — has unconditional stop-work authority. Unguarded hole, missing cut gloves, a lift that feels wrong, a ladder on mud: you say stop, the work stops, and we fix it. No retaliation, no eye-rolls, no exceptions for who''s senior.

The math never lies: stopping costs minutes; the injury costs weeks, fingers or worse. Sites with real stop-work culture have ''that was close'' stories, and sites without it have incident reports. Every stop gets logged in the app and reviewed, and the person who called it gets credit — being wrong and safe beats being right and lucky.', '["Anyone can stop any task, any time, for any safety doubt", "Stopping is free; there is no penalty for a ''wrong'' stop", "Say it plainly: ''Stop work \u2014 I see a problem''", "The fix happens before the task resumes, not after the job", "Log every stop in Issues \u2014 the record protects the next crew", "Seniors back up juniors who call it \u2014 that''s the whole culture"]'::jsonb, '["Someone hesitating to speak up because the foreman set the pace", "A known hazard being worked around instead of fixed", "Eye-rolling or pushback when a stop is called"]'::jsonb, 'If anything feels unsafe — anything — call stop-work, even if you might be wrong. Better embarrassed than injured.', 'I will stop work when I see danger, back up anyone who calls it, and fix the problem before the task resumes.')
on conflict (slug) do nothing;
