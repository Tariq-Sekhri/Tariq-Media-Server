const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const media = load('app/lib/media.ts');
const { matchesSearchQuery, parseSearchQuery, searchCompletionContext, completeSearchToken } = load('app/lib/search.ts', {}, { './media': media });
const item = (name, parent, extra = {}) => ({ name, parent, kind: 'video', tags: [], ...extra });

test('location and title words must both match, including nested locations', () => {
  assert.equal(matchesSearchQuery(item('Blue Moon.mp4', 'Music/Pop/Clips'), 'in:pop "blue moon"'), true);
  assert.equal(matchesSearchQuery(item('Blue Moon.mp4', 'Music/Other'), 'in:pop "blue moon"'), false);
  assert.equal(matchesSearchQuery(item('Other.mp4', 'Music/Pop/Blue Moon'), 'in:pop "blue moon"'), false);
  assert.equal(matchesSearchQuery(item('Blue Moon.mp4', 'Music/Pop'), 'in:pop blue moon'), true);
});

test('quoted full locations respect path boundaries and title filters', () => {
  const query = 'in:"My Library/Pop" title:"Blue Moon"';
  assert.equal(matchesSearchQuery(item('Blue Moon.mp4', 'My Library/Pop/Clips'), query), true);
  assert.equal(matchesSearchQuery(item('Blue Moon.mp4', 'My Library/Popcorn'), query), false);
  assert.equal(parseSearchQuery(query).filters.in[0], 'My Library/Pop');
  assert.equal(parseSearchQuery(query).text, '');
});

test('existing boolean filters, negation and incomplete filters work', () => {
  const video = item('Blue Moon.mp4', 'Pop', { favorite: true });
  assert.equal(matchesSearchQuery(video, 'in:pop type:video & !format:mkv is:favorite'), true);
  assert.equal(matchesSearchQuery(video, '!in:pop'), false);
  assert.equal(matchesSearchQuery(video, 'in:!pop'), false);
  assert.equal(matchesSearchQuery(video, 'type:mp3/mp4/mkv'), true);
  assert.equal(matchesSearchQuery(video, 'in:'), true);
  assert.equal(matchesSearchQuery(item('notes.pdf', 'Pop', { kind: 'file' }), 'type:file'), true);
});

test('completion preserves title text, surrounding filters, quotes and negation', () => {
  const query = '"blue moon" in:pop type:video';
  const caret = query.indexOf('pop') + 3;
  assert.equal(searchCompletionContext(query, caret).field, 'in');
  assert.equal(completeSearchToken(query, caret, 'My Library/Pop', 'in').query, '"blue moon" in:"My Library/Pop" type:video');
  assert.equal(completeSearchToken('!tag:ca', 7, 'calm sounds', 'tag').query, '!tag:"calm sounds" ');
  assert.equal(completeSearchToken('in:pop ', 7, 'type:').query, 'in:pop type:');
  assert.equal(completeSearchToken('in', 2, 'in:').query, 'in:');
  assert.equal(searchCompletionContext('in:"My Library/Po', 17).value, 'My Library/Po');
});
