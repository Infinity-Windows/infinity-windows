// The app's door to the scrubber. There is no second implementation here.
//
// The rules live in supabase/functions/_shared/scrub.ts because BOTH sides need
// them — the phone's crash reports and the edge functions' — and a scrubber that
// exists twice is a scrubber that will disagree with itself the first time
// somebody adds a key to one copy. This app already reaches into _shared for
// exactly this reason (crewInvites, estimate, pin, emailSender), so the shared
// module is the implementation and this file is the import path the app uses.
//
// Everything about WHAT is dropped and WHY is documented over there, and tested
// in scrub.test.ts next to this file.
export {
  MAX_BREADCRUMB_TEXT,
  REDACTED,
  isSensitiveKey,
  routePattern,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  scrubValue,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from "../../../../supabase/functions/_shared/scrub.ts";
