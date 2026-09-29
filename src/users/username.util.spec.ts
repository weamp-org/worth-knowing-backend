import {
  RESERVED_USERNAMES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  isUnsupportedScript,
  isValidUsername,
  normalizeUsername,
  normalizedReservedUsernames,
} from './username.util';

describe('normalizeUsername', () => {
  it.each([
    ['lowercases the identity form', 'AdaL', 'adal'],
    ['trims surrounding whitespace', '  adal  ', 'adal'],
    ['folds accents rather than truncating', 'Café', 'cafe'],
    ['handles a leading accent', 'Émile', 'emile'],
    ['folds full-width forms', 'Ａｄａ', 'ada'],
  ])('%s', (_label, input, expected) => {
    expect(normalizeUsername(input).usernameLower).toBe(expected);
  });

  // The case split is the whole reason there are two columns: a unique index is
  // case-sensitive in Postgres, so without `usernameLower` both of these would
  // be claimable and then resolve to the same profile URL.
  it('keeps the typed case for display and lowercases only the identity', () => {
    expect(normalizeUsername('AdaL')).toEqual({
      username: 'AdaL',
      usernameLower: 'adal',
    });
  });

  it('collapses distinct spellings of one name onto a single identity', () => {
    const spellings = ['AdaL', 'adal', 'ADAL', '  adal  '];

    expect(
      new Set(spellings.map((s) => normalizeUsername(s).usernameLower)).size,
    ).toBe(1);
  });

  it('folds accented and unaccented spellings together', () => {
    expect(
      new Set(
        ['Café', 'cafe', 'CAFÉ'].map((s) => normalizeUsername(s).usernameLower),
      ).size,
    ).toBe(1);
  });

  it('never throws, so callers can decide how to reject', () => {
    expect(() => normalizeUsername('')).not.toThrow();
    expect(() => normalizeUsername('!!!')).not.toThrow();
    expect(() => normalizeUsername('あ'.repeat(1000))).not.toThrow();
  });
});

describe('isValidUsername', () => {
  it.each(['ada', 'adal', 'ada_lovelace', 'a1b', '_ada'])(
    'accepts %j',
    (input) => {
      expect(isValidUsername(input)).toBe(true);
    },
  );

  it(`rejects usernames shorter than ${USERNAME_MIN_LENGTH}`, () => {
    expect(isValidUsername('a'.repeat(USERNAME_MIN_LENGTH - 1))).toBe(false);
    expect(isValidUsername('')).toBe(false);
  });

  it(`accepts exactly ${USERNAME_MAX_LENGTH} and rejects one more`, () => {
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH))).toBe(true);
    expect(isValidUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toBe(false);
  });

  it.each([
    ['a hyphen', 'ada-lovelace'],
    ['a space', 'ada lovelace'],
    ['a period', 'ada.lovelace'],
    ['a plus', 'c++'],
    ['a hash', 'c#'],
    ['an at sign', '@ada'],
    ['an emoji', 'ada🙂'],
  ])('rejects %s', (_label, input) => {
    expect(isValidUsername(input)).toBe(false);
  });

  // Digits are allowed inside a handle, but a handle made only of them reads as
  // a phone number, a year or a price rather than as a person.
  it.each(['123', '20260929', '007'])(
    'rejects the all-digits handle %j',
    (input) => {
      expect(isValidUsername(input)).toBe(false);
    },
  );

  it('rejects uppercase, because it validates the normalized form', () => {
    expect(isValidUsername('AdaL')).toBe(false);
  });
});

describe('isUnsupportedScript', () => {
  it.each(['日本語', 'Ελλάδα', 'русский', 'العربية'])(
    'flags %j as a script we cannot spell',
    (input) => {
      expect(isUnsupportedScript(input)).toBe(true);
      expect(isValidUsername(normalizeUsername(input).usernameLower)).toBe(
        false,
      );
    },
  );

  it.each(['ada', 'Café', 'ada_lovelace', 'a1b', 'machine learning'])(
    'does not flag Latin input %j',
    (input) => {
      expect(isUnsupportedScript(input)).toBe(false);
    },
  );

  it('does not flag punctuation-only input as an unsupported script', () => {
    expect(isUnsupportedScript('!!!')).toBe(false);
  });

  // The distinction is what lets a form say "that character isn't allowed" versus
  // "we can't spell your name yet" — a gap we promised to close, not a typo.
  it('separates unsupported script from merely invalid characters', () => {
    expect(isUnsupportedScript('русский')).toBe(true);
    expect(isUnsupportedScript('ada lovelace')).toBe(false);
  });
});

describe('RESERVED_USERNAMES', () => {
  it.each([
    'admin',
    'settings',
    'share',
    'resources',
    'official',
    'support',
    'worthknowing',
  ])('holds %j back', (word) => {
    expect(normalizedReservedUsernames()).toContain(word);
  });

  // The list is seeded through the same table a released handle uses, so every
  // entry has to survive folding. An entry that changed under NFKD would be
  // seeded under a key no claim would ever look up, leaving the word quietly
  // claimable.
  //
  // Not every entry is currently claimable-shaped — `u` and `wk` are below
  // {@link USERNAME_MIN_LENGTH}, so the shape check rejects them before the
  // reserved check runs. They are kept anyway: if the minimum is ever relaxed,
  // the seeded row is already there.
  it('is already normalized, so seeding stores exactly what a claim checks', () => {
    for (const word of normalizedReservedUsernames()) {
      expect(word).toBe(normalizeUsername(word).usernameLower);
    }
  });

  it('reserves nothing that the shape check would let through anyway', () => {
    const claimableButReserved = normalizedReservedUsernames().filter(
      (word) => isValidUsername(word) && word.length < USERNAME_MIN_LENGTH,
    );

    expect(claimableButReserved).toEqual([]);
  });

  it('has no duplicates, which would otherwise be a seeding-time crash', () => {
    const all = normalizedReservedUsernames();

    expect(new Set(all).size).toBe(all.length);
  });

  it('does not reserve the empty string', () => {
    expect(RESERVED_USERNAMES).not.toContain('');
  });
});
