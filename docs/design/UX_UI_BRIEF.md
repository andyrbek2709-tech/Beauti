# UX/UI Brief (Phase 0.5)

## Goal
Build a premium mobile booking experience that is fast, clear, and visually strong for Android/iPhone while keeping booking completion friction very low.

## Product constraints
- Multi-tenant product (many salons).
- Two channels share one schedule: Telegram + mobile web.
- One slot can be booked by only one client.
- Booking flow must complete in 2-3 steps.

## UX principles
- One primary action per screen.
- Minimal typing; mostly tap interactions.
- Clear state feedback: loading, success, conflict, error.
- Consistent visual hierarchy: date -> time -> confirmation.
- Friendly language, no technical wording.

## Mobile requirements
- Minimum interactive target: 44x44 px.
- Safe area support for iPhone notches.
- Base font size: 16px minimum for body.
- High contrast for text and CTA.
- Fast first render on mobile networks.

## Core scenarios
1. Client booking in mobile web.
2. Client cancellation from confirmation screen.
3. Slot conflict after stale selection (`409 slot_unavailable`).
4. Admin login.
5. Admin sets Telegram token + Telegram user ID.
6. Admin updates working windows and slot duration (30/45/60).

## Success metrics
- Booking completion rate >= 75% from first slot selection.
- Median booking time <= 60 seconds.
- Conflict recovery completion >= 50% (user books alternate slot).
- Admin onboarding (login + telegram setup) <= 3 minutes.

## Design deliverables
- Low-fi wireframes for all core screens.
- High-fi mockups (light theme MVP).
- Component kit: button, input, date pill, time slot card, toast, modal.
- State specs: default, loading, disabled, error, success.
- Copy sheet (microcopy for errors/success states).
