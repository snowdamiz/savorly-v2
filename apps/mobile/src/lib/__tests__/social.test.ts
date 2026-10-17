/// <reference types="jest" />
import { translator } from '../i18n/core';
import en from '../i18n/locales/en.json';
import ja from '../i18n/locales/ja.json';
import ru from '../i18n/locales/ru.json';
import { siteName, threads, timeAgo, wasEdited } from '../social';

const now = Date.parse('2026-10-16T12:00:00Z');
const before = (ms: number) => new Date(now - ms).toISOString();
const minute = 60_000;

describe('how long ago', () => {
  const t = translator('en', 'en-US', en, en);
  test('in words for the last week', () => {
    expect(timeAgo(before(20_000), now, t, 'en-US')).toBe('Just now');
    expect(timeAgo(before(5 * minute), now, t, 'en-US')).toBe('5 min ago');
    expect(timeAgo(before(60 * minute), now, t, 'en-US')).toBe('1 hour ago');
    expect(timeAgo(before(3 * 60 * minute), now, t, 'en-US')).toBe('3 hours ago');
    expect(timeAgo(before(24 * 60 * minute), now, t, 'en-US')).toBe('1 day ago');
    expect(timeAgo(before(6 * 24 * 60 * minute), now, t, 'en-US')).toBe('6 days ago');
  });

  test('as a date after that, with the year once it isn’t this one', () => {
    expect(timeAgo('2026-10-01T12:00:00Z', now, t, 'en-US')).toBe('Oct 1');
    expect(timeAgo('2025-12-24T12:00:00Z', now, t, 'en-US')).toBe('Dec 24, 2025');
  });

  test('a clock running a little behind, or no date at all', () => {
    expect(timeAgo(new Date(now + 30_000).toISOString(), now, t, 'en-US')).toBe('Just now');
    expect(timeAgo('', now, t, 'en-US')).toBe('');
  });

  test('in the reader’s language, with its plurals', () => {
    const r = translator('ru', 'ru-RU', ru, en);
    expect(timeAgo(before(minute), now, r, 'ru-RU')).toBe('1 минуту назад');
    expect(timeAgo(before(3 * minute), now, r, 'ru-RU')).toBe('3 минуты назад');
    expect(timeAgo(before(5 * 60 * minute), now, r, 'ru-RU')).toBe('5 часов назад');
    expect(timeAgo(before(21 * 60 * minute), now, r, 'ru-RU')).toBe('21 час назад');
    expect(timeAgo(before(2 * 24 * 60 * minute), now, r, 'ru-RU')).toBe('2 дня назад');
    const j = translator('ja', 'ja-JP', ja, en);
    expect(timeAgo(before(5 * minute), now, j, 'ja-JP')).toBe('5分前');
  });
});

test('edited means changed more than a minute after it was written', () => {
  expect(wasEdited('2026-10-16T12:00:00Z', '2026-10-16T12:00:00.4Z')).toBe(false);
  expect(wasEdited('2026-10-16T12:00:00Z', '2026-10-16T12:00:59Z')).toBe(false);
  expect(wasEdited('2026-10-16T12:00:00Z', '2026-10-16T12:05:00Z')).toBe(true);
  expect(wasEdited('2026-10-16T12:00:00Z', undefined)).toBe(false);
  expect(wasEdited('2026-10-16T12:00:00Z', null)).toBe(false);
});

test('a web address names its site, and only web addresses do', () => {
  expect(siteName('https://www.Example.com/recipes/42?ref=x')).toBe('example.com');
  expect(siteName('http://cook:pw@food.example.org:8080/a')).toBe('food.example.org');
  expect(siteName(' https://blog.example.net ')).toBe('blog.example.net');
  for (const url of [
    'javascript:alert(1)',
    'ftp://example.com',
    'example.com',
    '',
    null,
    undefined,
  ])
    expect(siteName(url)).toBe('');
});

describe('conversations', () => {
  const at = (m: number) => new Date(now + m * minute).toISOString();
  const c = (id: string, minute: number, parentId: string | null = null) => ({
    id,
    parentId,
    createdAt: at(minute),
  });
  test('oldest first, each with its replies', () => {
    const list = threads([c('b', 2), c('r1', 3, 'a'), c('a', 1), c('r2', 4, 'a'), c('r3', 5, 'b')]);
    expect(list.map((t) => [t.comment.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['r1', 'r2']],
      ['b', ['r3']],
    ]);
  });

  test('a reply to a reply joins the conversation; one without its comment stands alone', () => {
    const list = threads([c('a', 1), c('r1', 2, 'a'), c('r2', 3, 'r1'), c('lost', 4, 'gone')]);
    expect(list.map((t) => [t.comment.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['r1', 'r2']],
      ['lost', []],
    ]);
  });

  test('comments posted in the same moment keep their order, and loops break', () => {
    const list = threads([c('x', 1), c('y', 1), c('p', 2, 'q'), c('q', 3, 'p')]);
    expect(list.map((t) => t.comment.id)).toEqual(['x', 'y', 'p', 'q']);
  });
});
