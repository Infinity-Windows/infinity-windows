-- CAD-lite outline features: section divider lines and wall window/door
-- openings, stored per outline polygon.
-- { "dividers": [{id,a:{x,y},b:{x,y}}], "wallOpenings": [{id,edge,t,width,kind}] }

alter table project_plan_outlines
  add column if not exists features jsonb not null default '{}'::jsonb;
