/**
 * A token (BTP / ABAP Environment) against a real system.
 *
 * The suite never writes the session file. Two cases:
 *  - "connects": the access token alone. The provider is built WITHOUT the
 *    refresh token, so an expired access token is red — never a silent refresh
 *    that could rotate the refresh token another tool holds.
 *  - "renewal": a refused access token renewed by the refresh token. This one
 *    spends the refresh token and may rotate it server-side, so it runs only
 *    with `allow_refresh: true` in the `token` section, and is skipped with a
 *    printed reason otherwise.
 *
 * Skipped only when the `token` section is absent; a present section that fails
 * is red, because the provider's interactive login is refused here.
 *
 * Run:  npm run test:live:token
 */

import {
  cloudOver,
  describeLive,
  invalidAccessToken,
  RenewalOnlyTokenProvider,
  tokenSection,
} from '../helpers/liveConfig.js';
import { discovery, type LiveConnection } from '../helpers/liveSteps.js';

describeLive('token', (section) => {
  const setup = tokenSection(section);

  const build = (options: {
    accessToken?: string;
    useRefreshToken: boolean;
  }) => {
    const provider = new RenewalOnlyTokenProvider(setup.tokens, options);
    const conn = cloudOver(setup.config, provider, setup.rejectUnauthorized);
    return { provider, conn: conn as unknown as LiveConnection };
  };

  it('connects on the access token alone, and discovery answers 200', async () => {
    const { conn } = build({ useRefreshToken: false });
    try {
      await conn.connect();
      const response = await discovery(conn);
      expect(response.status).toBe(200);
    } finally {
      await conn.disconnect();
    }
  }, 120_000);

  const renewal = setup.allowRefresh ? it : it.skip;
  if (!setup.allowRefresh) {
    process.stderr.write(
      '[live:token] renewal case skipped — set "allow_refresh: true" in the token section to spend the refresh token (it may rotate server-side)\n',
    );
  }
  renewal(
    'a refused access token is renewed by the refresh token, and the one resend succeeds',
    async () => {
      const junk = invalidAccessToken();
      const { provider, conn } = build({
        accessToken: junk,
        useRefreshToken: true,
      });
      try {
        await conn.connect();
        const response = await discovery(conn);
        // The resend, not a second failure: 200 after the system said 401.
        expect(response.status).toBe(200);
        expect(provider.rejections).toBe(1);
        // A boolean: on a mismatch Jest would print both tokens.
        expect(provider.currentAccessToken() !== junk).toBe(true);
      } finally {
        await conn.disconnect();
      }
    },
    120_000,
  );
});
