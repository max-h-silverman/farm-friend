# Farm Friend Vashon SMS Compliance Requirements

## Purpose

Farm Friend Vashon is an SMS-first system for coordinating local farm volunteer shifts, gleaning, harvest help, weeding, and surplus produce pickups on Vashon Island, Washington.

Because the system sends outbound SMS messages over Telnyx using A2P 10DLC, all SMS-facing behavior must comply with the approved campaign registration language.

This document defines the required opt-in, opt-out, help, sample message, and privacy/terms behavior that must be reflected in the implementation.

## Program Name

Use this name consistently in SMS copy:

Farm Friend Vashon

Avoid shortening to only “Farm Friend” in required compliance messages unless space is extremely constrained.

## Campaign Description

The campaign description submitted to Telnyx is:

Farm Friend Vashon coordinates SMS notifications for local farm volunteer shifts, gleaning, harvest help, weeding, and surplus produce pickups on Vashon Island, Washington. Subscribers receive operational alerts about available farm help opportunities and confirmations for opportunities they claim. Subscribers can reply YES to claim an opportunity, HELP for help, MUTE to skip messages about a specific opportunity, FLAG to report an issue, or STOP to unsubscribe.

Implementation should match this actual use case. Do not add marketing, fundraising, promotional, political, or unrelated SMS traffic under this campaign.

## Opt-In Workflow

Subscribers opt in by texting `JOIN` to the Farm Friend Vashon phone number after seeing Farm Friend Vashon flyers, Facebook posts, Vashon Island Growers Association website posts, or in-person community outreach.

The printed or digital signup instructions must say:

> Text JOIN to +1 206-864-5326 (206-86-GLEAN) to receive SMS messages from Farm Friend Vashon about local farm volunteer shifts, gleaning opportunities, harvest help, and surplus produce pickups on Vashon Island. Message frequency varies based on farm needs, usually 0–6 messages per week. Message and data rates may apply. Reply HELP for help. Reply STOP to unsubscribe. Terms: https://farm-friend-vashon.web.app/terms. Privacy: https://farm-friend-vashon.web.app/privacy. Your mobile opt-in information will not be sold or shared with third parties for promotional or marketing purposes.

Use the assigned Telnyx number consistently anywhere the opt-in invitation is published.

After a subscriber texts `JOIN`, Farm Friend Vashon replies with an opt-in confirmation message. The coordinator may review and approve the subscriber before opportunity messages are sent.

## Required Keywords

### Opt-In Keywords

The system must recognize:

- `JOIN`
- `START`

`YES` is not an opt-in keyword. `YES` is only used to claim a specific opportunity after a user is already subscribed and eligible.

### Opt-Out Keywords

The system must recognize:

- `STOP`
- `UNSUBSCRIBE`
- `CANCEL`
- `END`
- `QUIT`

Any opt-out keyword must immediately unsubscribe the user from all future outbound messages, except legally/compliance-allowed confirmation of opt-out.

### Help Keywords

The system must recognize:

- `HELP`
- `INFO`

## Required Auto-Responses

### Opt-In Confirmation Message

When a user successfully opts in or requests to join, send:

Farm Friend Vashon: Thanks for subscribing to local farm volunteer shifts and produce pickups. Msg frequency varies, usually 0-6/week. Msg&data rates may apply. Consent is not a condition of purchase or participation. Reply HELP for help or STOP to opt out.

If the user still requires coordinator approval, the message may be followed by a short approval-status note, but do not remove the compliance language above.

### Opt-Out Confirmation Message

When a user sends `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, or `QUIT`, send:

Farm Friend Vashon: You’re unsubscribed and will receive no further messages. Reply JOIN to request to rejoin.

After this message, do not send further messages unless the user opts in again.

### Help Message

When a user sends `HELP` or `INFO`, send:

Farm Friend Vashon: Please reach out to max@myco.software or visit https://myco.software/farm-friend-vashon.html for help. Reply STOP to unsubscribe. Msg&data rates may apply.

## Supported User Commands

The SMS parser must handle these commands deterministically before invoking any LLM:

- `JOIN`
- `START`
- `YES`
- `YES N`
- `STOP`
- `UNSUBSCRIBE`
- `CANCEL`
- `END`
- `QUIT`
- `HELP`
- `INFO`
- `MUTE`
- `FLAG`

LLM handling should only run after deterministic command parsing fails.

## Message Frequency Disclosure

Any opt-in flow, printed signup copy, or digital signup copy must disclose:

Message frequency varies based on farm needs, usually 0–6 messages per week.

The exact frequency may vary operationally, but the system should be designed to stay within this expected pilot-scale range unless the campaign registration is updated.

## Message and Data Rates Disclosure

Any opt-in flow, printed signup copy, or digital signup copy must disclose:

Message and data rates may apply.

SMS confirmations may use the abbreviated version:

Msg&data rates may apply.

## Privacy and Terms URLs

Use these URLs consistently:

Privacy policy:
https://farm-friend-vashon.web.app/privacy

Terms:
https://farm-friend-vashon.web.app/terms

The privacy policy must include language stating that mobile opt-in information will not be sold or shared with third parties for promotional or marketing purposes.

## Sample Message Patterns

Outbound opportunity messages should look like the approved samples.

### Volunteer Shift Alert

Farm Friend Vashon: Plum Forest Farm needs help weeding Thu 9am. 2 spots open. Reply YES to claim, MUTE to skip this one, or STOP to unsubscribe.

### Confirmation Message

Farm Friend Vashon: You’re confirmed for Plum Forest Farm weeding Thu 9am. Thanks. Reply MUTE to stop further messages about this shift or STOP to unsubscribe.

### Surplus Pickup Alert

Farm Friend Vashon: Surplus kale is ready for pickup today and delivery to the food bank. Vehicle helpful. Reply YES if you can take it or STOP to unsubscribe.

## Outbound Message Requirements

Most outbound operational messages should include at least one obvious action and an opt-out path.

For opportunity alerts, include:

- Program name: Farm Friend Vashon
- Farm or pickup context
- Activity or task
- Date/time when applicable
- Available slots or claim status when applicable
- `Reply YES...`
- `STOP to unsubscribe`

For opportunity-specific followups, include:

- Program name: Farm Friend Vashon
- The relevant opportunity context
- `MUTE` if the user can stop messages about only that opportunity
- `STOP` if the user wants full unsubscribe

## STOP Behavior

STOP and equivalent opt-out keywords are global unsubscribe commands.

When received:

1. Mark the user as unsubscribed immediately.
2. Prevent future outbound messages to that phone number.
3. Send the required opt-out confirmation message.
4. Do not invoke the LLM.
5. Do not continue the thread with automated replies.
6. Allow rejoin only through a new `JOIN` or `START` request.

## MUTE Behavior

`MUTE` is not a global unsubscribe. It only silences followups about the current opportunity.

When received:

1. Identify the current opportunity thread/context.
2. Stop further messages about that opportunity.
3. Do not unsubscribe the user globally.
4. If there is no active opportunity context, reply with a short clarification and include STOP as the global unsubscribe option.

## FLAG Behavior

`FLAG` is a trust and safety command.

When received:

1. Create a flag record for admin review.
2. Stop automated replies on that thread until admin clears it.
3. Do not invoke the LLM for further replies on that thread.
4. Send a short confirmation such as:

Farm Friend Vashon: Thanks. This thread has been flagged for review, and automated replies are paused. Reply STOP to unsubscribe.

## JOIN Behavior

When a user texts `JOIN` or `START`:

1. If they are already approved and subscribed, confirm they are subscribed.
2. If they are new, create a pending user record.
3. Send the required opt-in confirmation message.
4. Surface the user for coordinator approval.
5. Do not send opportunity messages until approved, unless the product decision changes and compliance copy is updated accordingly.

## YES Behavior

`YES` and `YES N` are claim commands for active opportunities.

Rules:

1. Do not treat `YES` as opt-in.
2. Only process `YES` if the sender is subscribed and approved.
3. Only process `YES` if there is a claimable current opportunity.
4. For `YES N`, attempt to claim N slots if available.
5. Confirm success or explain if the opportunity is full/unavailable.
6. Do not invoke the LLM unless the reply is ambiguous beyond deterministic parsing.

## Privacy Requirements

The system must minimize personally identifiable information.

Required behavior:

- Store phone numbers only as needed for SMS operation.
- Do not log raw phone numbers unnecessarily.
- Do not sell or share mobile opt-in information for promotional or marketing purposes.
- Keep raw message content only as long as needed for operational/debugging purposes.
- Respect the 90-day message TTL unless a message is tied to an active opportunity or open flag.

## LLM Usage Constraints

The LLM must not be used for required compliance commands.

Never invoke the LLM for:

- STOP
- UNSUBSCRIBE
- CANCEL
- END
- QUIT
- HELP
- INFO
- JOIN
- START
- YES
- YES N
- MUTE
- FLAG

Use deterministic parsing first.

LLM may be used for:

- Parsing free-form farmer opportunity creation messages
- Classifying ambiguous volunteer replies
- Extracting opportunity details
- Drafting natural followup copy where appropriate

All LLM-generated SMS copy must still preserve required compliance behavior.

## Telnyx Campaign Attributes

Campaign content attributes should match the actual message content.

Use:

- Embedded Link: Yes
- Embedded Phone Number: No, unless outbound message bodies include phone numbers
- Number Pooling: No
- Age-Gated Content: No
- Direct Lending or Loan Arrangement: No

If links are removed entirely from SMS message bodies in the future, Embedded Link may be changed to No, but only if opt-in/help message requirements are still satisfied elsewhere.

## Implementation Checklist

Before launch:

- [ ] `JOIN` creates or reactivates a subscriber/pending user.
- [ ] `START` behaves like `JOIN`.
- [ ] STOP-equivalent keywords globally unsubscribe immediately.
- [ ] HELP-equivalent keywords return the approved help message.
- [ ] `YES` claims an active opportunity only for approved subscribers.
- [ ] `MUTE` silences only the current opportunity.
- [ ] `FLAG` pauses automation and surfaces admin review.
- [ ] LLM is bypassed for all deterministic commands.
- [ ] Opportunity alerts include clear reply instructions.
- [ ] Opportunity alerts include STOP language.
- [ ] Privacy policy URL exists and is publicly reachable.
- [ ] Terms URL exists and is publicly reachable.
- [ ] Privacy policy includes mobile opt-in non-sharing language.
- [ ] Printed opt-in flyer includes the full required CTA language.
- [ ] SMS copy uses “Farm Friend Vashon” consistently.
