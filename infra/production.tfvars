# The mount flags production actually runs with.
#
# ## Why this file exists, and the incident that produced it
#
# `mount_geocoding_key`, `mount_smtp_password` and `mount_email_verification` all default to
# `false`, because each secret's container must exist before its value does — the three-step
# gate each variable documents. That default is correct for creating a container and WRONG for
# every apply afterwards, and nothing recorded which flags production was actually running with.
#
# So every apply silently reverted whatever the previous one had enabled. **This is not
# hypothetical: `GEOCODING_API_KEY` was live on web revision 00034 and was stripped at 00035 by
# the SMTP apply, which passed `mount_smtp_password=true` and nothing else.** It has been absent
# from 00035, 00036, 00037 and 00038. Since F-077 made the typed address the only source of a
# coordinate, that means NO VISITABLE STAND CAN BE CREATED in production — a farmer's address
# cannot resolve. The apply reported success every time.
#
# A flag that lives only in a shell command is not configuration; it is something someone has to
# remember. This file is the record, and `-var-file=production.tfvars` is now part of every
# documented apply (RUNBOOK §Deploy).
#
# **Adding a mount flag means adding it HERE, in the same change**, or the next apply turns the
# feature off.

# F-069 — live since 2026-08-06, lost at revision 00035, restored by the apply that reads this.
mount_geocoding_key = true

# F-078 — live since revision 00037.
mount_smtp_password = true

# F-079 — FALSE until the three secret versions exist. The containers are created by an apply
# with this false; only then can it flip true, because `version = "latest"` on a versionless
# secret makes Cloud Run refuse the revision and would take the public map down.
#
# TRUE since 2026-08-07: all three versions exist, and `EMAIL_HASH_SALT` is the exact value the
# roster ingest used — verified by effect, by matching stored hashes through the shipped lookup.
mount_email_verification = true
