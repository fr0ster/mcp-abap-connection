/**
 * The one credential that can be told to get a new one.
 *
 * Renewal splits in two, and only one half is ever automatic: a token that has
 * EXPIRED is replaced inside `authorizationHeader()`, because the source is
 * asked per request and checks expiry before answering. Nobody decides
 * anything, and nothing here has to.
 *
 * The other half is a token the source still believes in and the server
 * refuses. `getToken()` is documented to hand back the cached one while it
 * believes it valid — which after a refusal is precisely what it wrongly
 * believes — so asking again returns the same rejected token. `refreshToken()`
 * is the contract's answer, and `renew()` is the only thing that reaches it.
 *
 * Nothing in this package calls it. Whether a refusal MEANT "stale" is a
 * judgement made with what the caller knows, so the refusal surfaces and the
 * caller decides. This is the seam they decide with.
 */
import type {
  IAuthProvider,
  IRenewableCredential,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
import {
  BasicAuthProvider,
  SamlAuthProvider,
  TokenAuthProvider,
} from '../auth/providers.js';

/** The narrowing a consumer writes, from the contract's own recipe. */
function isRenewable(c: IAuthProvider): c is IRenewableCredential {
  return typeof (c as Partial<IRenewableCredential>).renew === 'function';
}

function refresher() {
  const calls = { getToken: 0, refreshToken: 0 };
  let token = 'STALE';
  const source: ITokenRefresher = {
    getToken: async () => {
      calls.getToken += 1;
      return token;
    },
    refreshToken: async () => {
      calls.refreshToken += 1;
      token = 'FRESH';
      return token;
    },
  } as unknown as ITokenRefresher;
  return { source, calls };
}

describe('a credential backed by a refresher', () => {
  it('is renewable, and says so where a consumer can see it', () => {
    const { source } = refresher();
    const credential: IAuthProvider = new TokenAuthProvider(source);

    expect(isRenewable(credential)).toBe(true);
  });

  it('reaches refreshToken(), which nothing else does', async () => {
    const { source, calls } = refresher();
    const credential = new TokenAuthProvider(source);

    expect(await credential.authorizationHeader()).toBe('Bearer STALE');
    expect(calls.refreshToken).toBe(0);

    await credential.renew();

    // The point of the member: asking again would have returned the cached
    // token the server just refused.
    expect(calls.refreshToken).toBe(1);
    expect(await credential.authorizationHeader()).toBe('Bearer FRESH');
  });

  it('asks the source per request rather than holding an answer', async () => {
    const { source, calls } = refresher();
    const credential = new TokenAuthProvider(source);

    await credential.authorizationHeader();
    await credential.authorizationHeader();

    // Which is the whole mechanism by which an EXPIRED token is replaced with
    // nobody deciding to replace it.
    expect(calls.getToken).toBe(2);
  });
});

describe('a credential with nothing behind it', () => {
  it('a fixed token has nothing to force, and settles rather than pretending', async () => {
    const credential = new TokenAuthProvider('FIXED');

    // Still renewable by type — the class is one class — but honest at runtime:
    // there is no source to ask, so there is nothing to do.
    await expect(credential.renew()).resolves.toBeUndefined();
    expect(await credential.authorizationHeader()).toBe('Bearer FIXED');
  });

  it('a password is not renewable, and the guard says so', () => {
    const credential: IAuthProvider = new BasicAuthProvider('u', 'p');

    expect(isRenewable(credential)).toBe(false);
  });

  it('a handed-over SAML session is not renewable either', () => {
    const credential: IAuthProvider = new SamlAuthProvider('MYSAPSSO2=x');

    expect(isRenewable(credential)).toBe(false);
  });
});
