"""Business logic. Composes repos + agent + messaging to implement the
SMS-driven user flows: claim, outreach, post-event, message dispatch.

Nothing in this package imports Firestore SDK directly — repos own that.
"""
