-- B-010 — keep the provider's own explanation of a failed dispatch.
--
-- `error_code` stored only the HTTP status, which names a category and never a cause. The
-- gap cost hours twice on 2026-07-27: a stored '400' was really "The source phone number was
-- deemed invalid by the carrier" (a malformed TELNYX_FROM_NUMBER), and a '409' was really
-- Telnyx code 40300, "Blocked due to STOP message". Both sentences existed in the provider's
-- response and both were recovered by curling the API by hand instead of reading a row.
--
-- Two columns, deliberately separate:
--   provider_code         — the provider's machine token (e.g. 40300). Validated as a token
--                           before storage, so a future rule may safely key on it.
--   provider_error_detail — the human sentence. Diagnostic only; nothing branches on it.
--
-- Both are NULLABLE and are intentionally absent from the `coherent_result` check: they are
-- best-effort. A provider returning an unparseable body (a gateway's HTML 502, say) must
-- still be able to record its rejection, so requiring them would convert a malformed error
-- response into a failed write inside the dispatch path.
--
-- PRIVACY. `provider_error_detail` is phone-masked and length-bounded by
-- `summarizeProviderError` before it ever reaches this column. The real 40300 body names
-- both E.164 numbers, and Golden Rule #5 allows exactly one raw-phone column — this is not
-- it, and an operator reads this table precisely when debugging.

ALTER TABLE "outbox_dispatch_attempts" ADD COLUMN "provider_code" text;--> statement-breakpoint
ALTER TABLE "outbox_dispatch_attempts" ADD COLUMN "provider_error_detail" text;
