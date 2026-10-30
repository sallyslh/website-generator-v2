# Website generation pipeline: progress report

Date: 13 October 2026. Written for the project owner.

## 1. What this project is

A pipeline that takes a small business (its answers, photos and logo) and produces a real, working website: designed, written, built, checked, and editable by the customer. Nothing on the site is invented: products, prices and facts come only from the customer. Pictures are real photos, crops and collages of them, or (with the customer's approval) generated settings around the customer's real products.

Two web interfaces:
- **Customer page (port 3001):** the form, the sketches, approval, and now the website editor.
- **Control panel (port 3000):** for the team, with every stage, checks, costs and the Image lab.

## 2. The pipeline, stage by stage

| Stage | What it does | State |
|---|---|---|
| 1 Discovery | Turns the owner's answers into a structured brief (business, audience, tone, offerings, wishes, contact method) | Done |
| 2 Asset intelligence | Looks at every photo: what it shows, quality, overlays/watermarks, whether the product is whole | Done |
| 3 Creative director | Decides colors, fonts, sections, which picture goes where, a signature visual idea, the picture plan, and now the motion style | Done |
| 4 Content | Writes the real text for every section from the brief only | Done |
| 5 Design (Google Stitch) | Draws each page; the director's version is the default, a second style on request | Done |
| 6 Review | Customer chooses a sketch, pages are approved | Done |
| 7 Site | Turns the approved pages into a real Astro + Tailwind website | Done |
| 8 Features | Contact form that always delivers (WhatsApp, form service, email link, or removed), map, booking button | Done |
| 9 QA | Checks the built site automatically | Done (this period) |
| 10 Delivery | Zip, delivery record, hosting | Not built yet |

## 3. The main design decisions

- **Honesty first.** The model never sees unverifiable facts as truth; invented text is removed from pages and a check verifies none is left.
- **Real intelligence for pictures.** The creative director counts what photos exist (counted by code, not guessed), writes an image plan and a recipe per picture: use, crop, collage, composite, scene, atmosphere, or needs-photo.
- **Products are never redrawn.** A "scene" cuts the customer's real product out of its photo and stands it on a generated empty set. Generated pictures never contain products, logos, signs or text (checked by code and by a vision model), are limited to 4 per site, and are used only after the customer approves them.
- **Frames follow photos.** Picture shapes follow the photos' own shapes; the built pages are measured in a real browser and pictures are rebuilt to their real frame sizes.
- **Owner wishes.** The owner can write wishes for the home page and choose "only my own photos". The director answers every wish (used / adapted / declined, with a reason), shown to the customer.
- **Contact without a mail server.** WhatsApp first (the owner's number with country code), then a hosted form service, then an email link; a dead form is never shipped.
- **Side idea parked on purpose:** researching design trends from other websites. Not built unless you ask.

## 4. Built since the last report

### 4.1 Image lab (control panel, "Image lab" tab)
A test bench to try a photo-shoot idea on a real project without changing its design.
- "Ask for 3 ideas" (about 3 cents), then pick or write your own set, props, mood and shape, and tick which real products stand on it.
- A picture costs about 4 to 6 cents; the same idea twice is free (pieces are cached). Results are saved under the project's `lab/` folder with a history.
- Live test on Bonza produced a believable result. Known weakness: the products come out large, with no shadow under them, and the prop piles look symmetrical.

### 4.2 Motion
- The creative director chooses a motion personality for each brand: **calm** (perfume, luxury), **lively** (cafes, gift shops), **bold** (barbers, gyms) or **none**.
- Stage 7 writes `motion.css` and `motion.js`: the first screen's text rises on load; cards and pictures appear one after another while scrolling; lively and bold add hover lifts and zoom; bold adds slight parallax.
- Only transform and opacity move; nothing changes the layout or the words.
- Visitors who ask their device for reduced motion get the plain finished page, and so does anyone without scripts.
- Verified in a real browser (motion on, reduced motion, no script errors).

### 4.3 Stage 9: QA
No AI, no cost. Opens every page at phone width (390 px) and laptop width (1440 px) and reads the page code. Writes `qa-report.json`. Run: `node src/cli.js qa --project <id>`.
Checks include: titles/descriptions, language and viewport, one main heading per page, link/button names, picture descriptions, form labels, broken `#` links, page weight (over 3 MB fails), motion guards, sideways overflow, script errors and missing files, unreadable text (contrast below 3:1), plus advice on tap-target size and tiny text.
Results on real sites: My Sweet Home passes all 13 checks. Bonza had one failure left: a pale "Direct line" label on the contact page that is almost invisible (contrast 1.4:1). A missing favicon was found and fixed (the logo is now always copied to the build).

### 4.4 Website editor for the customer
The customer opens their real built website and edits it directly (`/site/<id>/?edit=1` on the customer server).
- **Text:** click, type, Enter to save, Escape to cancel (links and buttons use a small box).
- **Pictures and logo:** click, choose a photo, and describe it (required, for accessibility and search). A new logo replaces the old one on every page.
- **Your changes list:** every change with its original; undo per change; "Restore everything to the original".
- **Make one with AI:** a second tab in the picture box. The customer describes the place and mood, ticks up to 3 of their own products, gets a preview, and presses "Use this picture" or tries again. Products stay exactly as photographed; AI only makes the setting. A cheap rewriting step removes product words from the customer's text. Limit: 8 AI pictures per project (`MAX_AI_PICTURES_PER_PROJECT`), one at a time, switched off if the owner chose "only my own photos".
- **Never lost:** every edit is stored with its original, plus a pristine copy of the generated pages at the first edit. Edits survive a regeneration of the site; edits whose place disappeared are reported, not forced.
- **Instant:** edits are applied to the source pages and to the built pages, so there is no rebuild wait. The editing overlay exists only in edit mode and is never in the delivered site.
- A customer sees "Look at and edit my website" on their approved screen once the site is built.

### 4.5 Fixes found by testing on real data
- Prompt for the empty set told the model to put props at the edges, so it filled them with jars and books and the safety inspector refused four sets in a row. Fixed (uncluttered table); next run worked first time.
- Customer wording like "my perfume box on a table" was refused by the safe-subject rule; now rewritten into a set description first.
- Earlier in this period: cut-off products refused honestly, overlays (Instagram counters) cropped away, skeleton "loading bars" from Stitch removed, build memory problems handled (one thread, one retry), headless browser tools moved to `--headless=old`, git history cleaned of customer photos (you force-pushed).

## 5. Quality: tests

219 automated tests, all passing (they run one file at a time because this computer has little free memory). They use fake AI and image services, so they cost nothing. New this period: image lab (3), motion (4), QA (8), editing engine (7), editing server (1), AI editing (2).

## 6. Costs (approximate, per action)

| Action | Cost |
|---|---|
| Generated set (FLUX.2, about 1 MP) | about 1.2 cents |
| Cutting a product out of its photo | about 1 cent |
| One scene picture (set + cut-outs + props) | about 4 to 6 cents |
| Lab "3 ideas" | about 3 cents |
| Customer AI picture (rewrite + picture) | about 5 to 6 cents; capped at 8 per project |
| QA, editing, motion, delivery | free |

Google Stitch drawing is free. Language-model calls are logged per project in `cost-log.jsonl`.

## 7. Known weaknesses and risks

1. **Scene picture quality is not consistent yet:** products too large, no contact shadow, symmetrical prop piles. The generator also varies run to run.
2. **Faint text from Stitch designs** (like Bonza's "Direct line") fails QA; there is no automatic repair yet.
3. **No login on the customer page or the editor:** anyone with a project link can see and edit it. Needs protection before real customers.
4. **Text with markup inside** (a bold word in a sentence) is not editable yet; the Bonza header's menu texts are per page, so editing them only changes that page (the logo is site-wide).
5. **Editor tags** (`data-e`) stay in the page code; harmless, but should be stripped at delivery.
6. **Preview servers stop when a site is rebuilt**; restart needed.
7. **Memory:** the machine has little free RAM, which limits parallel work and builds.
8. **Not yet decided:** hosting. Cloudflare Pages is the recommendation (direct upload, free custom domains), but its commercial terms, project limits and deployment details are unverified. Vercel Hobby is non-commercial; Netlify's credit cap pauses all sites; AWS later. An email relay would need a domain you own.

## 8. What is uncommitted

Everything since commit `7cfa3fe`: image lab, motion, Stage 9, the editor, AI editing, the prompt fix, tests. Commit when you ask (no mention of Claude, as you instructed); the force-push is yours.

## 9. Suggested next steps (in this order)

1. **Delivery (Stage 10):** zip of the site, delivery record, refusing a site whose QA report has failures, stripping the editor tags.
2. **Automatic readability repair** for faint text, so QA failures like Bonza's fix themselves.
3. **Scene quality:** smaller products, soft shadows, natural prop scatter.
4. **Protection:** login or private links for the customer page and editor; spend limits per project.
5. **Hosting adapter** (Cloudflare) once you have the account and answers to the questions already listed.
6. **Change requests** that are bigger than text/picture edits (colors, layout) as written requests.
