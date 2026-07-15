# Inventory Hardware Shopping List

Total to get running: roughly $260–$420 one-time. No monthly hardware costs. Phones the crew already carries are the scanners.

## Label printer (pick one)

| Option | Price | Notes |
|--------|-------|-------|
| Rollo Wireless (X1040) | ~$180–210 | Recommended. Wifi + USB, prints from phone or Mac, no ink (direct thermal), handles 4x6 and 2x4 stock. |
| Zebra ZD421d | ~$300–400 | The industrial standard. Overkill at this scale but bulletproof if you want buy-once. |
| Phomemo/Jadens budget thermal | ~$90–130 | Works, but flimsier feed mechanisms; fine as a starter. |

Direct thermal printing fades in direct sunlight over months. Windows stored indoors are fine; if labels will ride on windows sitting outside for long periods, choose the Zebra with a thermal-transfer ribbon instead.

## Label stock

| Item | Spec | Price |
|------|------|-------|
| Window labels | 2" x 4" polypropylene (waterproof, tear-resistant) direct-thermal, permanent adhesive — ~500/roll | ~$25–35/roll |
| Rack/slot labels | Same 2x4 stock works; print address in large type + QR | (same roll) |
| Rack end-cap signs | 8.5" x 11" printed sheets in cheap sheet protectors, zip-tied to rack ends | ~$10 |

Buy 2 rolls to start (1,000 labels): covers the full conversion day plus months of receiving.

## Warehouse marking

- Floor marking tape, 2" wide, 2–3 colors (zone boundaries): ~$25
- Paint marker or large pre-printed numbers for rack IDs: ~$10
- Zip ties for hanging bay signs: ~$5

## Phones / scanning

- No scanner guns needed. The app scans QR codes with the phone camera in the browser.
- Requirement: the app must be served over HTTPS (it will be — deployed PWA), or phone browsers block camera access.
- Optional later: a cheap wall-mounted Android tablet (~$100) at the dock as a dedicated receiving station.

## Software costs

- Supabase (database, auth, photo/memo storage): $0/month free tier at 100–500 windows; ~$25/month if storage outgrows it later.
- App hosting (Vercel or Cloudflare Pages): $0/month.
- GitHub private repo: $0/month.
