# From a drawn website to a working one: real information, working buttons, and two panels

This document is the starting discussion for the next stage of the generator. Nothing in it is built yet unless it says so.

## 1. Where we are

The generator makes a website with sample content: sample pictures, names, prices and contact details. Every button that needs a real business behind it (book, order, call, directions, social links, "download the price list") is **switched off on purpose** (`data-inert`) so nothing points at a fake place.

Built and working today:

- Draft site generation (Stitch drawing, responsive phone/tablet/laptop, same menu everywhere, phone menu, heads kept in view, readable text, RTL languages, Translate).
- Approve, then edit in two ways: click on the page, or lists and forms with "paste many". Edits are saved as data, so the design never changes.
- Gates: nothing is published unless files, links, menu clicks (three screen sizes), page measures and the first-screen look all pass.
- An order/appointment request server and web-push notifications from the earlier version (`src/server/orders`), and the website assistant (chat) with its knowledge files.

## 2. The goal

When the owner has entered the real information, **every button that can work does work**, and what cannot work yet is listed for the owner in plain words. The owner and the team then have two places:

| | Panel 1: **My website** | Panel 2: **My team** |
|---|---|---|
| For | the owner (and whoever updates content) | the owner and the staff who answer customers |
| Question it answers | "What does my site say and look like?" | "What did my customers ask for today?" |
| Main screens | edit on the page, edit as lists, pictures, translate, preview, publish | inbox of requests, calendar, orders, customers, chat handoffs, settings |

## 3. Step A: the real-information form

One short form, asked after the owner approves the design (and again whenever something changes). Everything is optional except the first four, and the form says what each answer switches on.

| Question | Switches on |
|---|---|
| Business name, language | page titles, header, footer |
| Phone number | every "Call" button (`tel:`) |
| WhatsApp number | every "Chat / Message us" button (`wa.me/<number>?text=<prefilled message>`) |
| E-mail | "Email us" (`mailto:`) and the contact form's destination |
| Address (and optionally a map pin) | "Directions" (maps link), the map block, the footer address |
| Opening hours | the hours block, the "Open today until ..." badge (computed from the hours) |
| Instagram, Facebook, TikTok, Strava, Playtomic... | each social button |
| Booking link (Calendly etc.) or "use our booking form" | every "Book" button |
| Do you take orders? delivery? pick-up? | "Order" buttons and the cart |
| Real prices and items | through the lists editor (paste many, spreadsheet lines) |
| Logo, real photos | pictures editor |

The answers are stored once in `projects/<id>/business.json`. The website assistant (chat) reads the same file, so the site and the chatbot never disagree.

## 4. Step B: the button map

Today the inert buttons are anonymous. The plan:

1. **Classify once.** Each inert button gets a *kind* from its words and place: `call`, `whatsapp`, `email`, `directions`, `social:<network>`, `book`, `order`, `reserve-table`, `download`, `newsletter`, `legal` (privacy, terms), `reviews`, `other`. A small model call per site, remembered. The result is the **button map** (`wow-buttons.json`: page, button text, kind).
2. **Rewire from the form.** When the owner's answers are saved, code rewrites each button of a kind it now knows how to serve:
   - **Static, no backend needed (works the same day):** call, WhatsApp, email, directions, social, hours, map link, price-list download (a file the owner uploads).
   - **Needs the small backend (Step C):** book, reserve a table, order, contact form, newsletter.
   - **Needs content (the owner writes it):** legal pages (privacy, terms), "read all reviews".
3. **Report what is left.** A short list: "3 buttons need your Instagram, 2 need your privacy policy". Nothing is silently dead and nothing links to a fake place.
4. **Gate.** Go-live is blocked while sample data is still on the site: `example.com` e-mails, `555` phone numbers, invented reviews and prices. The check scans the built site.

Rewiring changes only `href` and a few attributes in the data (the structured site already keeps links as slots), so the design and the layout never change, and Undo works.

## 5. Step C: the small backend (one service for all sites)

Forms need somewhere to send. One small service, shared by all customer sites (each site has its own id):

- **Receives:** contact messages, booking requests, table reservations, orders (cart as a list of items), newsletter sign-ups, chat handoffs.
- **Protects itself:** honeypot field, rate limit per address, size limits, allowed origins (the site's own domain only), and a simple human check when abused.
- **Stores:** one record per request with a status (`new`, `seen`, `confirmed`, `declined`, `done`), the customer's details, a timestamp and the site id.
- **Notifies:** e-mail to the owner and WhatsApp/web-push to the team (the order server and web-push from the earlier version already do part of this).
- **Hosting:** a small serverless function plus a database (for example Cloudflare Workers with D1, or Supabase). The generated website stays static and fast; only the forms talk to the service.
- **Payments:** not in the first version. Orders are "pay on delivery / pay at the counter". Card payment later, through a payment provider's hosted page, never by handling card numbers ourselves.

## 6. Panel 1: My website

For whoever keeps the content up to date.

- **Edit on the page** and **Edit as lists and forms** (built).
- **Pictures:** replace, add, a focus point so heads are never cut; shape handling by cropping (no AI reshaping by default).
- **Business information:** the form from Step A, with the list of buttons it still cannot serve.
- **Languages:** Translate (built), with the page mirrored for Arabic.
- **Preview and publish:** preview on phone/tablet/laptop, then Publish (runs all gates; if one fails, nothing goes live and the owner sees a plain sentence about what to fix).
- **History:** every save is a version; one click restores an earlier one (not built).

## 7. Panel 2: My team

For the people who answer customers. It never shows design controls.

- **Inbox:** all new requests in one list, newest first, with the page they came from. Each has a status, a note, and one-tap reply by WhatsApp or e-mail.
- **Bookings and reservations:** a day/week calendar. Opening hours and slot length come from Step A. Staff confirm, decline or propose another time; the customer is told automatically.
- **Orders:** a board (`new`, `preparing`, `ready`, `delivered`) with a sound/notification for new orders; the printed ticket view for a kitchen.
- **Customers:** name, phone, history, notes (no more than the business needs).
- **Chat handoffs:** conversations from the website assistant that need a person, with the transcript.
- **Settings:** who is on the team, which notifications go where, blocked spam, export to a spreadsheet.

### People and permissions

| Role | Panel 1 | Panel 2 |
|---|---|---|
| Owner | everything, including publish and billing | everything |
| Editor | content, pictures, translate (no publish) | read only |
| Staff | no access | inbox, bookings, orders, customers |

Sign-in is by e-mail link (no passwords to forget). Every action in Panel 2 is logged with the person's name.

## 8. Proposed build order

1. **Business information form + button map + rewiring of the static buttons.** Large gain, no backend: call, WhatsApp, e-mail, directions, social and hours work the same day.
2. **Go-live gate for sample data.** Stops a site with `555` numbers from going public.
3. **Small backend + contact form + inbox** (Panel 2, first version).
4. **Bookings and reservations** with the calendar.
5. **Orders** and notifications.
6. **Roles and sign-in**, then history and restore in Panel 1.
7. **Payments** (later, optional).

## 9. Questions to settle before building

1. **Hosting for the backend:** which provider and who pays (per site, or one shared plan)? Is a custom domain per customer part of the offer?
2. **WhatsApp:** link-based only (free, the customer's own WhatsApp opens) or the WhatsApp Business API (automatic messages, but approval and cost)?
3. **Languages of the panels:** the team panel in the owner's language (Arabic, French, English)? The generator already mirrors Arabic.
4. **Privacy:** how long do we keep customer requests, and who can export or delete them?
5. **What the boss wants to show first:** the inbox (impressive and simple) or bookings?
6. **Booking rules:** one calendar per business, or per person/room/court? (A padel club needs courts; a dentist needs dentists.)

## 10. What stays automatic

As with the rest of the generator, none of this should depend on someone checking by eye:

- The button map and the rewiring are tested with fake information.
- Every new form has an end-to-end check in a real browser: fill it in, submit, see it in the inbox.
- The publish gate runs those checks too, so a broken booking button blocks publishing the same way a broken menu does.
