/**
 * A token (BTP / ABAP Environment) against a real system: the session's access
 * token, renewed by its refresh token. Skipped only when the `token` section is
 * absent; a present section that fails — an expired refresh token included — is
 * red, because the provider's interactive login is refused here.
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

  const build = (accessToken?: string) => {
    const provider = new RenewalOnlyTokenProvider(setup.tokens, accessToken);
    const conn = cloudOver(setup.config, provider, setup.rejectUnauthorized);
    return { provider, conn: conn as unknown as LiveConnection };
  };

  it('connects, and discovery answers 200', async () => {
    const { conn } = build();
    try {
      await conn.connect();
      const response = await discovery(conn);
      expect(response.status).toBe(200);
    } finally {
      await conn.disconnect();
    }
  }, 120_000);

  it('a refused access token is renewed by the refresh token, and the one resend succeeds', async () => {
    const { provider, conn } = build(invalidAccessToken());
    try {
      await conn.connect();
      const response = await discovery(conn);
      // The resend, not a second failure: 200 after the system said 401.
      expect(response.status).toBe(200);
      expect(provider.rejections).toBe(1);
    } finally {
      await conn.disconnect();
    }
  }, 120_000);
});
