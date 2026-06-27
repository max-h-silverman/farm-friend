# Farm Friend

Farm Friend is a dual-channel local food coordination platform for VIGA. It combines SMS, web, and native app surfaces so farmers, VIGA staff, volunteers, customers, restaurants, and other organizations can use the same underlying system through the channel that fits them.

Farm Friend is the clean-room replacement for VIGA's public farm map and becomes the source of truth for farm stand details and availability.

The clean-room MVP has two approved use cases:

- Farm stand availability: farmers publish current stand inventory; customers ask what is available, find ingredients, and get grounded recipe help.
- Gleaning volunteer coordination: VIGA staff create Food Bank gleaning opportunities; volunteers opt in, sign up, receive reminders, and VIGA sees a live tally.

This repo is currently in architecture setup. No production code has been written in the clean-room build yet.

## Source Of Truth

Read these docs in order:

1. `docs/PRODUCT_BRIEF.md` - product scope, actors, MVP boundaries, open questions.
2. `docs/ARCHITECTURE.md` - system architecture and tool choices.
3. `docs/DATA_ARCHITECTURE.md` - logical data model and storage decisions.
4. `docs/AI_ARCHITECTURE.md` - agentic seams, model boundaries, eval requirements.
5. `docs/SMS_COMPLIANCE.md` - SMS behavior, keyword rails, opt-in/out constraints.
6. `docs/BUILD_PLAN.md` - implementation phases and first backlog seed.

`CLAUDE.md` is the working guide for future coding agents.

## Current State

- Repo was reset to a hard clean slate from the old proof of concept.
- Architecture docs are the only live implementation guide.
- Preferred stack is TypeScript-first: shared core package, Postgres/Drizzle, Next.js web/API app, Expo native app, and SMS transport behind interfaces.
- TDD is required. The first feature should start from failing tests, not scaffolding-by-demo.
