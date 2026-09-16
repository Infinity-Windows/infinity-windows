# Description dictation

Every internal editable multiline description/notes field has a Dictate control. Single-line descriptions, idle notes, delay reasons, cost-code descriptions, warehouse notes, and vehicle-service descriptions use the same control. Names, identifiers, numeric fields, chat send controls, and unsigned public customer pages stay unchanged. Disabled/read-only fields have no control.

Tap Dictate, speak, and choose Stop & transcribe. Returned words append to whatever is in the field at that moment, including edits made while transcription was running. The normal form still owns validation, permission, and saving. Overflow is shown for manual copying rather than silently truncating a transcript. English/Spanish follows the app language.

The recorder requests permission only on a tap, stops its tracks on stop/cancel/unmount, and stops at three minutes or the 5 MB limit. A failed upload/transcription keeps the clip only in that open form's memory for Retry; closing discards it. It does not create an audio attachment. An internet connection is required; the device keyboard's own dictation remains an alternative.

`transcribe-description` re-verifies the signed-in user and rejects revoked/retired profiles. It accepts bounded multipart audio, uses the existing OpenAI Whisper account, and returns only text. It cannot save a report or edit a business record. A service-only atomic counter allows 120 requests per user per UTC day, independently of Ask's foreman role limit. The company content budget still applies. Usage counters are pruned after seven days; they never contain audio or text. Provider-reported duration settles the transcription charge.

Recording is sent to OpenAI for transcription. Forge does not persist this recording; this is not a claim about the provider's retention policy. API format and behavior: [official file-transcription documentation](https://developers.openai.com/api/docs/guides/speech-to-text). Whisper remains the app's configured transcription provider; this change does not switch models.

Validation covers the actual handler with isolated auth/database/provider boundaries, real PostgreSQL quota and permission rules, and browser workflows for append, retry, cancellation, permission denial, language, and ordinary form saving. Live verification should send a synthetic, non-sensitive spoken sentence through the deployed endpoint; never use crew audio for a smoke test.

The requested three-month deleted-user policy is a separate pending decision: whether job/payroll history should survive removal. No employee records are deleted by this change.
