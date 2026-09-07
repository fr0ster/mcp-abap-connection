/**
 * `x-sap-security-session: use`, on every request that has a session to use.
 *
 * ABAP Cloud issues its session as a resource, and Eclipse names it on
 * everything that follows rather than trusting the cookie alone. Measured from
 * ADT 3.60.3 against a BTP trial — a plain
 * `GET …/businessservices/odatav4/ZAC_SRVB01` and a
 * `POST …/unpublishjobs`, a read and a write, both stateless, both saying
 * `use`.
 */
import type { SapConfig } from '../config/sapConfig.js';
import { cloudHttpTransport, onPremHttpTransport } from './helpers/onPrem.js';

const config: SapConfig = {
  url: 'https://trial.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/** The headers a wire would put on the request, without sending one. */
function dressed(
  transport: { sendForTest?: unknown } & Record<string, unknown>,
): Record<string, string> {
  const dress = (transport as unknown as {
    dress: (h?: Record<string, string>) => Record<string, string>;
  }).dress;
  return dress.call(transport, {});
}

describe('CloudHttpTransport — the session it is already in', () => {
  it('says nothing before a session exists', () => {
    const wire = cloudHttpTransport(config);
    expect(dressed(wire as never)['x-sap-security-session']).toBeUndefined();
  });

  it('says `use` on every request once one does', () => {
    const wire = cloudHttpTransport(config);
    wire.ingest({ 'set-cookie': ['SAP_SESSIONID_TRL_100=abc; path=/'] });
    expect(dressed(wire as never)['x-sap-security-session']).toBe('use');
  });

  it('leaves on-prem alone — its session arrives with the logon', () => {
    const wire = onPremHttpTransport(config);
    wire.ingest({ 'set-cookie': ['SAP_SESSIONID_E19_100=abc; path=/'] });
    expect(dressed(wire as never)['x-sap-security-session']).toBeUndefined();
  });
});
