# Manual job location

A job address and its manual latitude/longitude point are independent. A foreman or above can edit either or both in Job location on the Overview. The point takes priority for directions; the street address stays readable. Clearing the point restores address-based directions. Changing address text does not move or erase a manual pin. There is no geocoding or device-location request.

The new coordinate columns are read through the existing job RLS and are not directly writable by client roles. The setter requires an internal current lead, an eligible nondeleted job and a valid complete decimal point. It compares the location captured when the editor opened, refusing a conflicting edit. Repeating already saved final values succeeds without another write. Other job fields, setup/readiness, time-clock evidence and proximity matching remain unchanged.

Job, My Work, Today, Schedule and trip job-site direction buttons use the same saved point. Nonjob travel addresses are unchanged. Schedule/travel queries retry without coordinate columns only when an older schema is missing them; other failures remain failures. Existing cached jobs without coordinate fields continue to use their addresses.

Database changes and the role/validation/protection probe require the real rolled-back workflow before merge. A public deployment/version check, deployed function verification, sandbox runtime rollback and signed-in read-only UI checks establish released state. Physical-device navigation remains distinct from link and browser tests.
