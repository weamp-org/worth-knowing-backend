import {
  TAG_SLUG_MAX_LENGTH,
  TAG_SLUG_MIN_LENGTH,
  isValidTagSlug,
  slugifyTag,
} from './slugify.util';

describe('slugifyTag', () => {
  it.each([
    ['lowercases', 'Evolution', 'evolution'],
    ['trims surrounding whitespace', '  evolution  ', 'evolution'],
    [
      'collapses internal spaces to hyphens',
      'machine learning',
      'machine-learning',
    ],
    ['collapses repeated hyphens', 'machine--learning', 'machine-learning'],
    ['trims edge hyphens', '--evolution--', 'evolution'],
    ['replaces punctuation runs with a single hyphen', 'a!!!b', 'a-b'],
    ['keeps dots', 'node.js', 'node.js'],
    ['keeps plus signs', 'C++', 'c++'],
    ['keeps hash so C# does not collide with C', 'C#', 'c#'],
    ['keeps existing hyphens', 'scikit-learn', 'scikit-learn'],
    ['maps underscores to hyphens', 'web_development', 'web-development'],
  ])('%s', (_label, input, expected) => {
    expect(slugifyTag(input)).toBe(expected);
  });

  it('collapses distinct spellings onto one identity', () => {
    const spellings = [
      'Machine Learning',
      'machine-learning',
      'MACHINE   LEARNING',
    ];

    expect(new Set(spellings.map(slugifyTag)).size).toBe(1);
  });

  it.each(['', '   ', '!!!', '---'])(
    'returns an empty slug for unnormalizable input %j',
    (input) => {
      expect(slugifyTag(input)).toBe('');
    },
  );

  it('leaves a lone dot intact, so the length check rejects it instead', () => {
    expect(slugifyTag('.')).toBe('.');
    expect(isValidTagSlug(slugifyTag('.'))).toBe(false);
  });

  it('never throws, so callers can decide how to reject', () => {
    expect(() => slugifyTag('')).not.toThrow();
    expect(() => slugifyTag('!!!')).not.toThrow();
    expect(() => slugifyTag('a'.repeat(1000))).not.toThrow();
  });
});

describe('isValidTagSlug', () => {
  it('accepts a slug within bounds', () => {
    expect(isValidTagSlug('ai')).toBe(true);
    expect(isValidTagSlug('c++')).toBe(true);
  });

  it(`rejects slugs shorter than ${TAG_SLUG_MIN_LENGTH}`, () => {
    expect(isValidTagSlug('a')).toBe(false);
    expect(isValidTagSlug('')).toBe(false);
  });

  it(`rejects slugs longer than ${TAG_SLUG_MAX_LENGTH}`, () => {
    expect(isValidTagSlug('a'.repeat(TAG_SLUG_MAX_LENGTH))).toBe(true);
    expect(isValidTagSlug('a'.repeat(TAG_SLUG_MAX_LENGTH + 1))).toBe(false);
  });
});
