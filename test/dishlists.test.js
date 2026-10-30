// Long menus: the model only says which dishes go where; code copies names, prices and descriptions from the owner's list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillListedSections, dishProblems, isListedSection, dishIndex } from '../src/stages/04-content/dishLists.js';
import { pagePrompt } from '../src/stages/04-content/prompts.js';
import { contentSpecSchema, pageSchema } from '../src/schemas/contentSpec.js';

const brief = { offerings: [
  { name: 'Fattoush', description: 'Salad with sumac', price: '8', category: 'Salad' },
  { name: 'Kibbeh', description: '', price: '12', category: 'Mains' },
  { name: 'Knefeh', description: 'Cheese and syrup', price: '', category: 'Dessert' },
  { name: 'Hummus', description: '', price: '5', category: '' },
] };
const designPage = { slug: 'menu', sections: [{ id: 'menu-header', type: 'page-header', slots: [] }, { id: 'menu-salad', type: 'menu-category', slots: [] }, { id: 'menu-dessert', type: 'menu-category', slots: [] }] };
const written = () => ({ slug: 'menu', seo: { title: 't', description: 'd' }, sections: [{ id: 'menu-header', heading: 'Menu' }, { id: 'menu-salad', heading: 'Salads', dishes: [1, 0, 99] }, { id: 'menu-dessert', heading: 'Desserts', dishes: [2, 0] }].map((s) => ({ subheading: '', body: [], items: [], imageAlt: {}, ...s })) });

test('which sections are lists: menu categories and product lists, not heroes or featured products', () => {
  assert.deepEqual(['menu-category', 'product-grid', 'hero', 'featured-products', 'page-header'].map((type) => isListedSection({ type })), [true, true, false, false, false]);
});

test('items are copied from the owner\'s list: exact name, description and price, in the owner\'s order; bad numbers and repeats are ignored', () => {
  const page = written();
  const left = fillListedSections({ brief, designPage, page });
  const salad = page.sections[1]; const dessert = page.sections[2];
  assert.deepEqual(salad.items, [{ title: 'Fattoush', text: 'Salad with sumac — 8' }, { title: 'Kibbeh', text: '12' }].slice(0, 2), 'dish 0 and 1 in list order; 99 does not exist');
  assert.deepEqual(dessert.items.map((i) => i.title), ['Knefeh', 'Hummus'], 'dish 0 was already placed; the forgotten uncategorised dish 3 goes to the last list');
  assert.deepEqual(left, [3]);
  assert.equal(dessert.items[0].text, 'Cheese and syrup', 'no price: the description alone');
  assert.ok(salad.dishes === undefined && dessert.dishes === undefined, 'the helper field is removed');
  assert.equal(page.sections[0].items.length, 0, 'a header gets no dishes');
  assert.doesNotThrow(() => pageSchema.parse(page));
});

test('a forgotten dish goes to the section named like its category', () => {
  const page = written(); page.sections[1].dishes = []; page.sections[2].dishes = [];
  const brief2 = { offerings: [{ name: 'Fattoush', description: '', price: '8', category: 'Salad' }, { name: 'Knefeh', description: '', price: '', category: 'Dessert' }] };
  fillListedSections({ brief: brief2, designPage, page });
  assert.deepEqual([page.sections[1].items.map((i) => i.title), page.sections[2].items.map((i) => i.title)], [['Fattoush'], ['Knefeh']]);
});

test('the model must place nearly every dish, or it is asked again', () => {
  const page = written(); page.sections[1].dishes = [0]; page.sections[2].dishes = [];
  assert.equal(dishProblems({ brief, designPage, page }).length, 1);
  page.sections[1].dishes = [0, 1]; page.sections[2].dishes = [2, 3];
  assert.deepEqual(dishProblems({ brief, designPage, page }), []);
  assert.deepEqual(dishProblems({ brief, designPage: { sections: [{ id: 'x', type: 'hero' }] }, page }), [], 'a page without list sections has nothing to place');
});

test('the prompt gives a list page the numbered dishes, and no other page', () => {
  const design = { pages: [designPage, { slug: 'home', sections: [{ id: 'home-hero', type: 'hero', slots: [] }] }] };
  const ctx = { brief: { ...brief, business: {}, goals: [], audience: '', pages: [], features: [], brand: { personality: [] }, tone: '', language: 'en', unknowns: [] }, design, manifest: { assets: [], documents: [] }, global: { siteTitle: 's', primaryCta: {}, navigation: [] } };
  const menu = pagePrompt({ ...ctx, page: { slug: 'menu', title: 'Menu', purpose: 'p' } });
  assert.match(menu, /THE OWNER'S DISHES/); assert.match(menu, /"i":3,"name":"Hummus"/);
  assert.doesNotMatch(pagePrompt({ ...ctx, page: { slug: 'home', title: 'Home', purpose: 'p' } }), /THE OWNER'S DISHES/);
  assert.equal(dishIndex(brief).length, 4);
});

test('a section with a new name from the creative director is still recognised as a list, and a preview is not', () => {
  const yes = ['menu-category', 'product-grid', 'menu-board', 'dish-list', 'ticket-wall', 'price-ledger', 'catalog', 'full-menu', 'collection-grid'];
  const no = ['hero', 'story', 'menu-preview', 'featured-products', 'featured-dishes', 'page-header', 'info-band', 'cta-band', 'contact-info', 'category-strip', 'gallery'];
  assert.deepEqual(yes.filter((type) => !isListedSection({ type })), []);
  assert.deepEqual(no.filter((type) => isListedSection({ type })), []);
});
