import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderInterviewHtml } from '../adapters/interview/index.mjs';
import { renderGalleryHtml } from '../adapters/concept-gallery/index.mjs';

class Element {
  constructor(tag, registry) { this.tagName = tag; this.registry = registry; this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; this.value = ''; this.checked = false; this.textContent = ''; this.className = ''; this.type = ''; this.files = []; this.style = {}; }
  set id(value) { this._id = value; this.registry.set(value, this); }
  get id() { return this._id; }
  set name(value) { this._name = value; }
  get name() { return this._name; }
  setAttribute(name, value) { this[name] = value; }
  append(child) { this.children.push(child); child.parent = this; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) {
    const all = this.descendants();
    if (selector === '[data-parent]') return all.filter(el => el.dataset.parent);
    if (selector === '[data-select]') return all.filter(el => el.dataset.select);
    return [];
  }
  querySelector(selector) { if (selector === 'img') return this.descendants().find(el => el.tagName === 'img') ?? null; return null; }
  closest(selector) { if (selector === '[data-select]' && this.dataset.select) return this; if (selector === '[data-revision]' && this.dataset.revision) return this; return null; }
  classList = { toggle: () => {} };
  reset() { for (const el of this.descendants()) { el.value = ''; el.checked = false; } }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { this.clicked = true; this.onclick?.(); }
  set innerHTML(value) {
    this._html = value;
    if (this.tagName !== 'article') return;
    const image = new Element('img', this.registry); image.src = value.match(/<img src="([^"]+)/)?.[1] ?? ''; this.append(image);
    const textarea = new Element('textarea', this.registry); textarea.dataset.comment = value.match(/data-comment="([^"]+)"/)?.[1] ?? ''; this.append(textarea);
    for (const match of value.matchAll(/<button([^>]*)>(.*?)<\/button>/g)) {
      const button = new Element('button', this.registry), attrs = match[1];
      for (const [attr, key] of [['data-select', 'select'], ['data-revision', 'revision'], ['data-candidate', 'candidate']]) { const found = attrs.match(new RegExp(attr+'="([^"]+)"')); if (found) button.dataset[key] = found[1]; }
      button.textContent = match[2]; this.append(button);
    }
  }
  get innerHTML() { return this._html; }
}

class BrowserHarness {
  constructor(html, local = new Map()) {
    this.registry = new Map(); this.local = local; this.downloads = []; this.nodes = [];
    this.document = {
      createElement: tag => { const el = new Element(tag, this.registry); this.nodes.push(el); return el; },
      getElementById: id => this.registry.get(id) ?? (() => { const el = new Element('div', this.registry); el.id = id; this.nodes.push(el); return el; })(),
      querySelector: selector => {
        const match = selector.match(/^\[data-(select|comment)="(.+)"\]$/); if (!match) return null;
        const key = match[1] === 'select' ? 'select' : 'comment';
        return this.nodes.flatMap(el => [el, ...el.descendants()]).find(el => el.dataset[key] === match[2]) ?? null;
      },
    };
    this.document.querySelector = this.document.querySelector.bind(this.document);
    for (const match of html.matchAll(/<([a-z0-9]+)[^>]*\bid="([^"]+)"/gi)) {
      const el = new Element(match[1], this.registry); el.id = match[2]; this.nodes.push(el);
    }
    const form = this.document.getElementById('interview'); form.elements = { namedItem: name => form.descendants().find(item => item.name === name) ?? null };
    form.append(this.document.getElementById('questions'));
    this.document.getElementById('zoom').append(new Element('img', this.registry));
    this.context = {
      document: this.document,
      localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
      crypto: { randomUUID: () => 'artifact-uuid' },
      URL: { createObjectURL: blob => { this.lastBlob = blob; return 'blob:download'; }, revokeObjectURL: () => {} },
      Blob: class { constructor(parts, options) { this.parts = parts; this.type = options?.type; } async text() { return this.parts.join(''); } },
      setTimeout: () => 0, Date, JSON, String, Object, Array, Error, RegExp, Promise, CSS: { escape: s => s },
      console,
    };
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInNewContext(script, this.context);
  }
  el(id) { return this.document.getElementById(id); }
  control(name) { return this.el('interview').elements.namedItem(name); }
  static interview(questionnaire, local = new Map()) { return new BrowserHarness(renderInterviewHtml(questionnaire), local); }
  static gallery(set, local = new Map()) { return new BrowserHarness(renderGalleryHtml(set), local); }
}

test('interview browser script saves revision history, restores canonical export, exports real Markdown newlines, and handles version mismatch', async () => {
  const q = { id: 'demo', version: '1', questions: [
    { id: 'kind', type: 'select', label: 'Kind', options: [{ value: 'other', label: 'Other' }] },
    { id: 'other', type: 'text', label: 'Details', when: { questionId: 'kind', equals: 'other' } },
    { id: 'agree', type: 'checkbox', label: 'Agree', requirementKind: 'fact' },
    { id: 'show', type: 'checkbox', label: 'Show detail' },
    { id: 'detail', type: 'text', label: 'Conditional detail', when: { questionId: 'show', equals: true } },
  ] };
  const local = new Map(), page = BrowserHarness.interview(q, local), form = page.el('interview');
  assert.equal(page.el('questions').querySelectorAll('[data-parent]')[0].hidden, true);
  page.control('kind').value = 'other'; form.listeners.change();
  assert.equal(page.el('questions').querySelectorAll('[data-parent]')[0].hidden, false);
  page.control('other').value = 'I want a quieter interface'; form.listeners.input();
  page.control('agree').checked = false; form.listeners.change();
  const checkboxConditional = page.el('questions').querySelectorAll('[data-parent]').find(section => section.dataset.parent === 'show');
  assert.equal(checkboxConditional.hidden, true);
  page.control('show').checked = true; form.listeners.change();
  assert.equal(checkboxConditional.hidden, false);
  let saved = JSON.parse(local.get('creative-interview:demo:1'));
  assert.equal(saved.kind, 'interview_responses'); assert.equal(saved.revision, 3); assert.equal(saved.history.length, 2);
  assert.equal(saved.answers.find(a => a.questionId === 'agree').value, false);
  assert.equal(saved.requirements.find(a => a.sourceRefs.includes('answer:agree')).kind, 'fact');
  page.el('export-json').click(); const exported = JSON.parse(await page.lastBlob.text());
  assert.equal(exported.id, saved.id); assert.equal(exported.history.length, 2);
  page.el('export-md').click(); const markdown = await page.lastBlob.text();
  assert.match(markdown, /\n## Requirements projection\n/); assert.doesNotMatch(markdown, /\\n## Requirements/);
  const imported = BrowserHarness.interview(q, new Map());
  imported.el('file').onchange({ target: { files: [{ text: async () => JSON.stringify(exported) }], value: '' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(imported.control('other').value, 'I want a quieter interface');
  assert.equal(imported.control('show').checked, true);
  const restored = BrowserHarness.interview(q, local);
  assert.equal(restored.control('other').value, 'I want a quieter interface');
  assert.equal(restored.control('agree').checked, false);
  const mismatch = { ...exported, questionnaire: { id: 'demo', version: '0' } };
  const file = restored.el('file'); file.onchange({ target: { files: [{ text: async () => JSON.stringify(mismatch) }], value: '' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(restored.el('status').textContent, /explicit migration is required/);
});

test('gallery browser script zooms images and keeps preference, combination request, and export state distinct', async () => {
  const digest = 'a'.repeat(64), c = i => ({ id: `c${i}`, version: '1', title: `Direction ${i}`, thesis: 'Hypothesis', description: 'Desc', choices: ['Choice'], fit: 'Fit', tradeoff: 'Tradeoff', image: { path: `images/${i}.png`, digest: String(i).repeat(64), mimeType: 'image/png', width: 100, height: 100 }, provider: { id: 'fixture' } });
  const set = { id: 'set', version: '1', requestedCount: 3, explorationMode: 'product-structure', candidates: [c(1), c(2), c(3)] };
  const local = new Map(), page = BrowserHarness.gallery(set, local), grid = page.el('grid'), cards = grid.children;
  cards[0].querySelector('img').click(); assert.equal(page.el('zoom').open, true);
  const select = grid.querySelectorAll('[data-select]')[1]; grid.listeners.click({ target: select });
  const comment = page.document.querySelector('[data-comment="c2"]'); comment.value = 'Strong layout'; grid.listeners.input();
  const combine = grid.descendants().find(el => el.dataset.revision === 'combine'); grid.listeners.click({ target: combine });
  const saved = JSON.parse(page.context.localStorage.getItem('concept-gallery:set:1'));
  assert.equal(saved.preferences.find(p => p.candidateId === 'c2').selected, true);
  assert.equal(saved.preferences.find(p => p.candidateId === 'c2').comment, 'Strong layout');
  assert.equal(saved.revisionRequests[0].type, 'combine'); assert.equal(saved.revisionRequests[0].approved, false); assert.equal(saved.acceptance, false);
  page.el('export').click(); const exported = JSON.parse(await page.lastBlob.text()); assert.equal(exported.setVersion, '1');
  const restored = BrowserHarness.gallery(set, local);
  assert.equal(restored.document.querySelector('[data-select="c2"]').dataset.selected, 'true');
  assert.equal(restored.document.querySelector('[data-comment="c2"]').value, 'Strong layout');
  assert.equal(JSON.parse(local.get('concept-gallery:set:1')).revisionRequests.length, 1);
});
