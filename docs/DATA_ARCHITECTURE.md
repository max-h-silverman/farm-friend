# Farm Friend Data Architecture

## Storage Choice

Use Postgres as the source of truth with Drizzle migrations. The domain has natural relational constraints: farms own stands, stands have inventory snapshots and items, people have roles and subscriptions, gleaning opportunities have signups, and messages/audits link across flows.

## Core Entities

### People And Roles

- `people`
  - id
  - display_name
  - phone_e164 encrypted or access-controlled
  - phone_hash for lookup/log correlation
  - email
  - status: pending, active, suspended, unsubscribed
  - created_at, updated_at

- `person_roles`
  - person_id
  - role: admin, viga_staff, farmer, volunteer, customer, food_bank_partner

- `subscriptions`
  - person_id
  - program: global_sms, farmstand, gleaning
  - channel: sms, app_push, email
  - status: opted_in, muted, opted_out
  - consent_source
  - consented_at
  - disclosure_version

`global_sms` records whether a person can receive Farm Friend SMS at all. Program rows record which broadcasts or program-specific flows they participate in. `STOP` ends SMS globally; program-level mute/opt-out can be added without weakening carrier opt-out behavior.

### Farms And Stands

- `farms`
  - id
  - name
  - public_description
  - owner_person_id
  - status: draft, pending_review, public, hidden, archived
  - profile_review_status
  - created_by_person_id nullable
  - approved_by_person_id nullable

- `farm_stands`
  - id
  - farm_id
  - name
  - address
  - public_location_note
  - map_url
  - hours_text nullable
  - payment_note nullable
  - update_cadence_hours nullable
  - visibility: public, hidden

- `inventory_snapshots`
  - id
  - farm_stand_id
  - source_channel: sms, web, mobile, admin
  - note
  - published_at
  - updated_at
  - expected_fresh_until nullable
  - status: draft, current, superseded, hidden
  - confirmed_by_person_id

- `inventory_items`
  - id
  - snapshot_id
  - farm_stand_id
  - normalized_item_name
  - display_item_name
  - quantity_value nullable
  - quantity_unit nullable
  - quantity_label nullable, e.g. some, a lot, limited
  - price_text nullable
  - tags derived by code where useful

### Gleaning

- `gleaning_opportunities`
  - id
  - title
  - crop
  - location_name
  - address
  - starts_at
  - ends_at
  - volunteer_min
  - volunteer_max
  - organizer_person_id
  - food_bank_partner_id nullable
  - status: draft, scheduled, open, full_enough, full, completed, cancelled
  - public_note
  - reminder_sent_at

- `gleaning_signups`
  - id
  - opportunity_id
  - person_id
  - status: confirmed, dropped, waitlisted
  - waitlist_position nullable
  - source_channel
  - signed_up_at
  - dropped_at

Database constraints:

- Unique active signup per person per opportunity.
- `volunteer_min >= 1`.
- `volunteer_max >= volunteer_min`.
- Confirmed count cannot exceed `volunteer_max` unless an admin override field is explicitly added later.
- Waitlisted count may exceed `volunteer_max`, but only one active signup or waitlist row per person per opportunity is allowed.

### Messaging And Conversation

- `messages`
  - id
  - person_id nullable for unknown sender
  - phone_hash
  - direction: inbound, outbound
  - channel: sms, web, mobile, push
  - program nullable
  - body_redacted or encrypted body depending on retention policy
  - provider_message_id
  - intent_label
  - created_at
  - ttl_delete_at

- `conversation_states`
  - id
  - person_id
  - program
  - flow
  - state_json
  - pending_confirmation_json
  - expires_at

- `flags`
  - id
  - person_id
  - message_id nullable
  - reason
  - status: open, resolved
  - created_at, resolved_at

### AI Audit And Evals

- `ai_runs`
  - id
  - seam
  - model_provider
  - model_name
  - schema_version
  - input_summary
  - output_summary
  - validation_status
  - created_at

Do not store full prompts/responses containing sensitive data by default.

## Freshness Policy

Freshness is a first-class product display concern, not a hidden exclusion rule.

- `published_at`: when the farmer first confirmed the inventory snapshot.
- `updated_at`: when the inventory was last changed or re-confirmed.
- `expected_fresh_until`: optional timestamp derived from farmer-configured cadence.
- `update_cadence_hours`: farm stand setting for reminder timing and freshness copy.

MVP behavior:

- Do not hide older inventory by default.
- Always show or say when inventory was last updated.
- If `expected_fresh_until` is past, label the listing as older than the farmer's usual update cadence.
- Farmers should be able to configure their own cadence; staff/admin can set a default during onboarding.

## Query Rules

- Customer availability answers read visible inventory snapshots by default.
- Older items can be shown only with explicit `updated at` or cadence language.
- Recipe answers retrieve inventory first, then generate from those records plus general food knowledge.
- If a requested item is not present in visible inventory, the system says no listing found.
- Specific quantity requests such as "5 lbs of tomatoes" should prefer exact quantities when available and otherwise explain uncertainty rather than treating approximate labels as guaranteed supply.

## Privacy And Retention

- Normalize and hash phone numbers for lookup.
- Never log raw phone numbers.
- Store raw phone numbers only where operationally required. Use encryption before public pilot; access control plus salted hashes is acceptable during early local scaffold work.
- Keep raw SMS bodies only as long as operationally useful.
- Use TTL cleanup for routine messages.
- Preserve flagged messages and audit records until resolved and retention policy allows deletion.
