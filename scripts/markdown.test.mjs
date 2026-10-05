import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownCodeFence, markdownCodeSpan } from './markdown.mjs';

test('inline code keeps backticks and line breaks inside one code span', () => {
  const tick = String.fromCharCode(96);
  const value = 'file' + tick + '](https://example.test)\nsecond-line';
  const result = markdownCodeSpan(value);

  assert.equal(result, tick.repeat(2) + value.replace('\n', ' ') + tick.repeat(2));
  assert.equal(result.includes('\n'), false);
});

test('code fences use a delimiter longer than any run in the content', () => {
  const tick = String.fromCharCode(96);
  const innerFence = tick.repeat(3);
  const value = 'commit message\n' + innerFence + '\nspoofed heading';
  const result = markdownCodeFence(value);
  const lines = result.split('\n');

  assert.equal(lines[0], tick.repeat(4));
  assert.equal(lines.at(-1), tick.repeat(4));
  assert.equal(lines.slice(1, -1).join('\n'), value);
});

test('inline code handles empty and boundary-delimiter values', () => {
  const tick = String.fromCharCode(96);

  assert.equal(markdownCodeSpan(''), tick + tick);
  assert.equal(markdownCodeSpan(tick + 'name' + tick), tick.repeat(2) + ' ' + tick + 'name' + tick + ' ' + tick.repeat(2));
});
