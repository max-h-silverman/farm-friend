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

# B-045. Both Gmail OAuth secret versions now exist; selecting Gmail moves delivery to HTTPS.
mount_gmail_delivery = true

# F-079 — FALSE until the three secret versions exist. The containers are created by an apply
# with this false; only then can it flip true, because `version = "latest"` on a versionless
# secret makes Cloud Run refuse the revision and would take the public map down.
#
# TRUE since 2026-08-07: all three versions exist, and `EMAIL_HASH_SALT` is the exact value the
# roster ingest used — verified by effect, by matching stored hashes through the shipped lookup.
mount_email_verification = true

# F-113 — the custom domain every public and SMS link is built from.
#
# HERE rather than in `terraform.tfvars`, which is gitignored: a value that lives on one machine
# is not configuration. An apply from another checkout would omit it, `PUBLIC_BASE_URL` would
# fall back to the `*.run.app` host, and the domain mapping would be DESTROYED — reverting the
# antivirus/carrier-filter fix while reporting success. That is the same failure that produced
# this file.
#
# The CNAME (`farmfriend` -> `ghs.googlehosted.com`) is added by hand at VIGA's nameserver
# provider; Terraform holds no credential for that zone. Domain ownership is verified in Google
# Search Console by the account that runs the apply.
public_host = "farmfriend.vigavashon.org"

# F-123 — where a new FLAG or texted issue report is emailed (max, 2026-08-19).
#
# In THIS file rather than the gitignored `terraform.tfvars`, for the same reason `public_host`
# is: an apply from another checkout that omitted it would silently stop every alert while
# reporting success, and nothing would notice until a flag went unread.
flag_alert_email = "farmfriend@vigavashon.org"
