import type { Agent } from 'node:https';
import { AbstractAbapConnection } from '../../connection/AbstractAbapConnection.js';

class TestConn extends (AbstractAbapConnection as any) {
  protected getHttpsAgentOptions() {
    return { cert: 'C', key: 'K' };
  }
  async connect() {}
  protected buildAuthorizationHeader() {
    return '';
  }
  getAgent(): Agent {
    return (this as any).getAxiosInstance().defaults.httpsAgent;
  }
}

test('getHttpsAgentOptions merges into the https.Agent', () => {
  const Ctor = TestConn as unknown as new (...args: unknown[]) => TestConn;
  const c = new Ctor(
    { url: 'https://h:44300', authType: 'basic' } as any,
    null,
  );
  const agent = c.getAgent();
  // NOTE: `agent.options` is a Node-internal field (not public API); assertion may need
  // updating across Node majors. Verifies the merged cert/key reach the real https.Agent.
  expect((agent as any).options.cert).toBe('C');
  expect((agent as any).options.key).toBe('K');
});
