import { expect, test } from 'bun:test';
import { createComposerDrafts, mergeComposerDrafts } from '../../public/composer-drafts.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const draft = (text, mentions = []) => ({ text, mentions });

test('drafts survive reload, isolate contexts and do not expose mutable references', () => {
  const storage = memoryStorage(), store = createComposerDrafts(() => storage);
  store.set('thread:A', draft('A', [{ id: 'file:A', title: 'A' }]));
  store.set('thread:B', draft('B'));
  store.get('thread:A').mentions[0].title = 'changed';
  const loaded = createComposerDrafts(() => storage);
  expect(loaded.get('thread:A')).toEqual(draft('A', [{ id: 'file:A', title: 'A' }]));
  expect(loaded.get('thread:B').text).toBe('B');
  loaded.remove('thread:A');
  expect(createComposerDrafts(() => storage).get('thread:A').text).toBe('');
});

test('unavailable or corrupt storage does not discard in-memory typing', () => {
  for (const storage of [() => { throw new Error('denied'); }, () => ({ getItem: () => '{broken', setItem: () => { throw new Error('quota'); } })]) {
    const store = createComposerDrafts(storage);
    store.set('thread:A', draft('Keep typing'));
    expect(store.get('thread:A').text).toBe('Keep typing');
  }
});

test('bounded recovery keeps recent drafts, validates data and never truncates long input in memory', () => {
  const storage = memoryStorage(), store = createComposerDrafts(() => storage);
  for (let i = 0; i < 22; i++) store.set(`thread:${i}`, draft(String(i)));
  expect(store.get('thread:0').text).toBe('');
  expect(createComposerDrafts(() => storage).get('thread:21').text).toBe('21');
  store.set('long', draft('x'.repeat(250_001)));
  expect(store.get('long').text.length).toBe(250_001);
  expect(createComposerDrafts(() => storage).get('long').text).toBe('');
  storage.setItem('codex-webui-composer-drafts', JSON.stringify([null, ['bad', { text: 42 }], ['valid', draft('ok', [null, { id: 'x', title: 'safe', unknown: {} }])]]));
  expect(createComposerDrafts(() => storage).get('valid')).toEqual(draft('ok', [{ id: 'x', title: 'safe' }]));
});

test('failed submissions retain both original text and newer input without duplicate mentions', () => {
  expect(mergeComposerDrafts(draft('Original', [{ id: 'a' }]), draft('New input', [{ id: 'a' }, { id: 'b' }]))).toEqual(draft('Original\n\nNew input', [{ id: 'a' }, { id: 'b' }]));
});
