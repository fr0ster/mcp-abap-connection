jest.mock(
  'kerberos',
  () => ({
    initializeClient: jest.fn(async () => ({
      step: jest.fn(async (_c: string) => undefined),
      response: 'YIIBexyz==',
    })),
  }),
  { virtual: true },
);

import { generateSpnegoToken } from '../../auth/kerberosSpnego.js';

test('generateSpnegoToken returns a base64 token for an SPN', async () => {
  const token = await generateSpnegoToken('HTTP@sap-host.corp');
  expect(token).toBe('YIIBexyz==');
});
