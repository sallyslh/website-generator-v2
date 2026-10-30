# Brief for an outside adviser (paste this whole file into Claude or ChatGPT)

I am building an AI website generator for small businesses. I want your honest advice on a few product and technical decisions. Please read the whole brief, then answer the questions at the end. Be direct: tell me what you would do, what you would not do, and why. Do not just list options.

## 1. What the product is

A business owner enters very little, and the system generates ONE stunning, image-rich, creative website for them. The owner then reviews it, edits it with simple clicks, and goes live. The target customers are small local businesses (restaurants, cafes, padel clubs, salons, shops), many of them in Lebanon and the Middle East, so languages other than English and phone-first visitors matter.

## 2. What my boss wants (his point of view)

- A very attractive, eye-catching, "wow" website on the first try, even if the content is fake (fake photos, people, phone and email). The wow comes first. The real details and a "go-live" gate come afterwards.
- Every site must look different and creative every time. No templates, no photocopies of earlier sites.
- It must look good and load fast on every device: phone, tablet, laptop, TV, including slow phone connections. He will open the result on his phone, a tablet or a laptop, with no effort from him (just a link).
- The customer enters very little: business name, domain, business type (or "Other"), at least 3 pages from a suggested list, language (English by default), and optionally a logo, brand colours and a few taste notes ("bright", "dark", "nude tones").
- Menu items must always work, and no two different menu items may show the same page. Other buttons may be inert in the first draft.

## 3. How it works today (what we built)

Pipeline in Node.js, one run per business:

1. **Page list per business type**: the model proposes plain, well-known page names (12-20 pages with sections), saved once per type. Works for any typed business. Nothing is obligatory; minimum 3 pages.
2. **Concept**: a creative direction is drawn at random from many directions and checked, so no two sites share a look. Logo and brand colours are respected when given.
3. **Brief**: one Claude call writes the idea, tone, and fake sample content.
4. **Drawing**: Google Stitch draws each page and its pictures as a laptop screen. Stitch has a daily limit of about 50 screens, so about 4 sites of 12 pages per day.
5. **Assembly**: pictures downloaded, optionally upscaled, written as a static site.
6. **Links**: every menu item works, no duplicates; other links show a friendly note until real details exist.
7. **Responsive redesign** (new, and it made the biggest difference): Stitch pages are laptop-first and were 12,000 px tall on a phone. One Claude call per page rewrites the layout classes mobile-first (compact hero, side-by-side small items, swipe rows for card groups, landscape pictures, two columns on tablet), with the laptop look unchanged. A check rejects any rewrite that changes a word, a picture, a link or a script. Cost about $4-5 per 12-page site the first time; answers are cached.
8. **Polish**: styles precompiled, icons load safely, pictures in phone sizes, TV scaling, slow-phone loading test.

Result on a padel club test site: phone page height dropped by about 40% (Home 12,040 px to 7,112 px), laptop and tablet look unchanged. The boss-facing preview is a public GitHub Pages link.

Earlier I also built, in an older pipeline: a website chatbot for the visitors of each site (knowledge from the owner's files and form facts, three answer categories, WhatsApp handoff, daily caps, automatic tuning, owner coaching), cart and cash-on-delivery ordering via WhatsApp, owner alerts, and an editable delivered site with undo and restore. I want to keep the chatbot and its refinements, and bring the owner editing to the new generated sites.

## 4. What I want to add next

**Owner editing after the customer approves the site.** The owner should be able to:
- click any text and edit it,
- click any picture and replace it with their own,
- enter their own real information (phone, email, hours, prices, address, social links) manually,
- and the AI should keep the same style, even when the owner's pictures have different sizes and shapes from the ones we generated (so the layout should adapt, not break and not squash the photo).

**The chatbot** on every generated site, with the rules and refinements it already has, switched on after real information exists.

## 5. Known limits and open problems

- Stitch's daily screen limit caps how many sites per day.
- Stitch pictures sometimes contain leaked page text or "a website inside the website"; a prompt fix reduced it but is not fully verified on every site.
- The responsive redesign relies on a model rewriting class names. It is checked for content, but not yet for visual quality; a second pass that looks at a phone screenshot and fixes problems is not built.
- Editing in a plain static site is harder than in a framework with components; I need a simple, reliable way to store the owner's edits so a regeneration does not erase them.

## 6. Questions for you

1. **Strategy**: given the boss's goal (wow first, real details later, many different sites), what are the biggest risks in this approach, and what would you change first?
2. **Owner editing design**: what is the simplest reliable architecture for click-to-edit text and click-to-replace images on a generated static site? Where should edits be stored (inside the HTML, a separate JSON of overrides, a small CMS)? How do I make sure a rebuild or a redesign does not erase the owner's edits?
3. **Images of different sizes**: when the owner replaces a picture with one of a different shape, how should I keep the design intact? Compare: fixed-ratio frames with `object-fit: cover` plus a focal-point picker, an AI step that outpaints or reframes the photo, or a layout that adapts to the picture. What would you choose, and what are the failure cases?
4. **AI keeping the style**: should an AI be used at all when the owner replaces pictures (colour grading to match, background extension), or is it better to keep the owner's photos exactly as they are? What do real website builders do?
5. **Responsive quality**: is "one model call per page rewrites the layout classes, then verify nothing else changed" a sound approach, or is there a more reliable tool or method to make a laptop-first design truly responsive? How should I check the visual quality automatically?
6. **Chatbot on a static site**: how would you add a visitor chatbot that answers only from the business's own facts, hands off to WhatsApp, and is cheap to run? What guardrails matter most?
7. **Cleanup**: I have a large old pipeline (interview, file analysis, creative director, content writing, a separate Stitch design stage, an Astro build, features, QA, an orders panel, two older web interfaces) next to the new generate-first flow. How should I decide what to archive and what to keep, and is it better to start a fresh repository for the new flow and port only the chatbot and editor?
8. **Pricing and scale**: with about $4-5 of model cost per site plus Stitch's limits, what is a sensible way to price and limit this for small businesses?
9. **What am I not asking?** What would you worry about that I have not mentioned?

Please answer each question in order, with a clear recommendation first and a short reason after it.
