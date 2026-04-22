# Screen Specs (Mobile-First)

## Client flow screens

### C1. Choose Date
- Header: salon name + short subtitle.
- Horizontal date chips for next 14 days.
- Disabled style for unavailable days.
- CTA appears only after date selected.

### C2. Choose Time
- Time slots in 2-column cards.
- Available: solid border, readable contrast.
- Busy: hidden by default (MVP) or disabled if needed.
- On slot tap: sticky CTA "Continue".

### C3. Confirm Booking
- Summary block: date, time, duration, salon.
- Inputs: name, phone.
- Primary CTA: "Book now".
- Secondary: "Back".

### C4. Success
- Success icon + short confirmation text.
- Booking ID visible.
- Actions: "Cancel booking", "Book another time".

### C5. Conflict/Error
- Message: selected slot already booked.
- Suggest 3 nearest available slots.
- Action: "Choose another slot".

## Admin web screens

### A1. Login
- Email/password only.
- CTA: "Sign in".
- Link to registration.

### A2. Registration
- Salon name, email, password.
- CTA: "Create salon account".

### A3. Telegram Integration
- Fields: bot token, telegram user ID.
- CTA: "Save and connect".
- Success state: connected, last updated time.

### A4. Schedule Settings
- Slot duration selector: 30 / 45 / 60.
- Weekly windows editor (day + start + end).
- Date exceptions list.
- CTA: "Save schedule".

### A5. Day Appointments
- Date picker.
- List of appointments with time, client, source.
- Daily total counter.

## Global error states
- Network lost.
- Session expired.
- Validation errors in forms.
- API conflict (`409`) for slot booking.

## Acceptance checklist
- Booking can be completed in <= 3 screens.
- All primary actions are thumb-friendly.
- Error states are actionable and understandable.
- Admin can complete setup without developer help.
