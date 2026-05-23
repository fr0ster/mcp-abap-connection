import { Agent } from 'node:https';
import { AbstractAbapConnection } from '../../connection/AbstractAbapConnection.js';

class TestConn extends (AbstractAbapConnection as any) {
  protected getHttpsAgentOptions() { return { cert: 'C', key: 'K' }; }
  async connect() {}
  protected buildAuthorizationHeader() { return ''; }
  getAgent(): Agent { return (this as any).getAxiosInstance().defaults.httpsAgent; }
}

test('getHttpsAgentOptions merges into the https.Agent', () => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — constructor is protected on abstract class, bypassed via 'as any'
  const c = new TestConn({ url: 'https://h:44300', authType: 'basic' } as any, null);
  const agent = c.getAgent();
  expect((agent as any).options.cert).toBe('C');
  expect((agent as any).options.key).toBe('K');
});
