# Website generator (v2)

Makes a complete, image-rich, multi-page website for a small business from very little information, then lets the owner edit it as content. Every site works on a phone, a tablet, a laptop and a TV, and nothing is published unless automatic checks pass.

## The journey

1. **Choose pages.** Business name, domain, kind of business (or "Other"), at least three pages, language, optional logo, brand colours and taste notes.
2. **Generate.** A creative concept is chosen (the *look* is classic for trusted professions such as dentists, doctors and lawyers, bold or modern for others), Google Stitch draws every page, then code and one model call per page make it responsive, give every page the same menu and a phone menu, keep heads in view, keep text readable and check the first screen.
3. **Review and approve.**
4. **Convert to code.** Lists of cards become data; texts and pictures become editable parts; the page is rebuilt exactly (verified) from data.
5. **Edit.** On the page itself, or as lists and forms with "paste many". Translate to another language (Arabic, Persian and Urdu mirror the layout).
6. **Publish** only if every gate passes.

Next stage (see `docs/OWNER-AND-TEAM-PANELS.md`): real information, working buttons, and two panels (the owner's website panel and the team panel).

## Run it

```
npm install
copy .env.example .env     # then fill in ANTHROPIC_API_KEY and STITCH_API_KEY
npm run wow                # the website maker: http://localhost:3010
node src/server/editor.js  # the editors: http://localhost:3020
npm test                   # all tests
```

Useful commands (`node src/cli.js <command>`):

| Command | What it does |
|---|---|
| `wow --project <id> --name ... --type ... --pages a,b,c [--look classic\|modern\|bold] [--language Arabic]` | generate a site into `projects/<id>/wow-site` |
| `structure --project <id>` | convert to code (lists, texts, pictures become data) |
| `build-structured --project <id>` | rebuild the site from the data |
| `translate --project <id> --to Arabic` | translate into a new project |

Tools (`node tools/<name>.mjs`): `gates` (every check on a finished site), `publish` (builds, checks, pushes, then checks the live link), `click-test` (clicks every menu link at three sizes), `measure-site`, `link-audit`, `crop-check`, `pages-to-pdf`.

## Layout of the code

- `src/wow/` the generator: `run.js` (the pipeline), `concept.js`, `brief.js`, `prompt.js`, `assemble.js`, `linkFix.js`, `anchors.js`, `menu.js` (one menu, phone menu, readability), `responsive.js`, `repair.js`, `hero.js`, `firstScreen.js`, `focus.js`, `rtl.js`, `translate.js`, `structure.js`, `gates.js`, `polish.js`, `deviceCheck.js`
- `src/server/` the website maker (`wow.js`), the editors (`editor.js`, `listEditor.js`), the order/appointment server (`orders/`)
- `src/stages/` the earlier staged pipeline (still used for the chat assistant and shared helpers)
- `src/data/business-types/` what each kind of business needs (pages, sections)
- `test/` tests (`npm test`), `tools/` scripts, `evals/` evaluation sets, `test-businesses/` sample inputs

## Secrets and customer data

`.env` (API keys) and `projects/` (customer sites and photos) are never committed.
