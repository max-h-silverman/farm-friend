-- F-098 — a farmer claim that NO administrator issued.
--
-- The grandfathered door (`/farmer/start/…`) is the honour-system route: a farmer picks their
-- own farm from a dropdown and proves an email VIGA already holds. There is no administrator
-- in that loop, so it could not write a `farmer_invitations` row at all — the column was NOT
-- NULL with a foreign key to `administrators`.
--
-- That mattered once `JOIN <token>` was removed (2026-08-07) and farm identity moved to a phone
-- the farmer states on the onboarding form. START matches an inbound handset against
-- `pending_phone_hash`, which lives HERE — so a door that cannot write this row is a door whose
-- farmer can never finish onboarding. The grandfathered farmer lost their only path and got no
-- replacement.
--
-- The row now means "a pending farmer claim", and who issued it is what varies: an administrator
-- for an invited farmer, nobody for a self-issued one. Everything downstream — START matching,
-- redemption, authorization, the welcome text — keys on the row and is unchanged.
ALTER TABLE "farmer_invitations"
  ALTER COLUMN "created_by_administrator_id" DROP NOT NULL;

-- A self-issued claim must name the farm it is for.
--
-- An invited row may have a null `farm_id` (VIGA invites a farmer before the farm exists, and
-- the redemption binds it). A self-issued one cannot: the farm selection IS the credential —
-- there is no token naming one, and no administrator to bind it later. A row with neither an
-- issuer nor a farm would be a claim about nothing that START could still match.
ALTER TABLE "farmer_invitations"
  ADD CONSTRAINT "farmer_invitations_self_issued_names_farm"
  CHECK ("created_by_administrator_id" IS NOT NULL OR "farm_id" IS NOT NULL);

-- An approval that NO administrator granted (max's call, 2026-08-09).
--
-- `farm_approvals` is what lets a farm publish inventory, and redemption writes one crediting
-- the administrator who minted the invitation. A self-issued claim has no such person, so the
-- column blocked the honour-system farmer at the last step of their own onboarding: authorized,
-- and then refused on their first update.
--
-- NULL means the farm published on the honour system and NOBODY vetted it. That is a real
-- widening and it is deliberate: this door is already the widest in Farm Friend — picking your
-- farm from a dropdown and proving an email VIGA holds is the whole claim — and requiring an
-- approver here would only be satisfied by naming one who never acted. **VIGA's revoke is the
-- backstop**, the same one that covers the listing this farmer can already publish.
ALTER TABLE "farm_approvals"
  ALTER COLUMN "administrator_id" DROP NOT NULL;
