import { clerkDisplayName, resolveDisplayName } from './display-name.util';

describe('clerkDisplayName', () => {
  it('prefers the full name', () => {
    expect(
      clerkDisplayName({ fullName: 'Ada Lovelace', username: 'ada' }),
    ).toBe('Ada Lovelace');
  });

  // A Clerk username is a name the person chose, so it is a real answer rather
  // than a consolation prize.
  it('falls back to a Clerk username', () => {
    expect(clerkDisplayName({ fullName: null, username: 'ada' })).toBe('ada');
  });

  it('does not treat an empty string as a name', () => {
    // Clerk can return `""` rather than `null` for a field that is present but
    // blank, and `??` alone would store the empty string as somebody's name.
    expect(clerkDisplayName({ fullName: '', username: '' })).toBeNull();
    expect(clerkDisplayName({ fullName: '', username: 'ada' })).toBe('ada');
  });

  // The regression this module exists for. `'Anonymous'` used to be stored as
  // somebody's name, which collided with the product's own anonymity feature: a
  // byline reading "Shared by Anonymous" sat next to "Shared anonymously",
  // meaning two entirely different things.
  it('returns null rather than inventing a name', () => {
    expect(clerkDisplayName({ fullName: null, username: null })).toBeNull();
  });

  it('never returns the word "Anonymous"', () => {
    const results = [
      clerkDisplayName({ fullName: null, username: null }),
      clerkDisplayName({ fullName: '', username: '' }),
      clerkDisplayName({ fullName: null, username: undefined as never }),
    ];

    for (const result of results) {
      expect(result?.toLowerCase()).not.toBe('anonymous');
    }
  });
});

describe('resolveDisplayName', () => {
  it('prefers the stored Clerk name', () => {
    expect(resolveDisplayName({ name: 'Ada Lovelace', username: 'AdaL' })).toBe(
      'Ada Lovelace',
    );
  });

  // A user who signed up without giving a name is shown by the handle they
  // claimed here, which is a name they chose.
  it('falls back to the claimed handle', () => {
    expect(resolveDisplayName({ name: null, username: 'AdaL' })).toBe('AdaL');
  });

  it('returns null only when there is neither', () => {
    expect(resolveDisplayName({ name: null, username: null })).toBeNull();
  });

  it('does not treat an empty string as a name', () => {
    expect(resolveDisplayName({ name: '', username: 'ada' })).toBe('ada');
    expect(resolveDisplayName({ name: '', username: '' })).toBeNull();
  });

  it('never returns the word "Anonymous"', () => {
    const results = [
      resolveDisplayName({ name: null, username: null }),
      resolveDisplayName({ name: 'Anonymous', username: 'ada' }),
    ];

    expect(results[0]).toBeNull();
    // A user genuinely called "Anonymous" is a real person, and the handle is
    // still available to disambiguate them — so this is passed through, not
    // rewritten. The point is that we never *manufacture* it.
    expect(results[1]).toBe('Anonymous');
  });
});
