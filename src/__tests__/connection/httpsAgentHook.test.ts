/**
 * TLS client-certificate material reaches the real https.Agent.
 *
 * The claim is unchanged; where the evidence lives is not. HTTP used to be a
 * branch inside `getAxiosInstance()`, so the agent could be read off that
 * instance's `defaults`. It is a transport now, and the connection holds an
 * adapter rather than an axios instance — so the assertion goes to the thing
 * that actually builds the agent.
 *
 * This is the seam where the two axes touch: the material comes from the
 * CREDENTIAL and configures the TRANSPORT, which is why it arrives as a thunk
 * read at build time rather than a value read at construction.
 */
import type { Agent } from 'node:https';
import { AbstractAbapConnection } from '../../connection/AbstractAbapConnection.js';
import { HttpTransport } from '../../connection/HttpTransport.js';

class TestConn extends (AbstractAbapConnection as any) {
  protected getHttpsAgentOptions() {
    return { cert: 'C', key: 'K' };
  }
  async connect() {}
  protected buildAuthorizationHeader() {
    return '';
  }
  /** The thunk the connection hands its default transport. */
  agentOptions() {
    return (this as any).getHttpsAgentOptions();
  }
}

function agentOf(transport: HttpTransport): Agent {
  return (transport as any).client().defaults.httpsAgent;
}

test('getHttpsAgentOptions merges into the https.Agent', () => {
  const Ctor = TestConn as unknown as new (...args: unknown[]) => TestConn;
  const c = new Ctor(
    { url: 'https://h:44300', authType: 'basic' } as any,
    null,
  );

  const agent = agentOf(new HttpTransport(() => c.agentOptions()));

  // NOTE: `agent.options` is a Node-internal field (not public API); assertion may need
  // updating across Node majors. Verifies the merged cert/key reach the real https.Agent.
  expect((agent as any).options.cert).toBe('C');
  expect((agent as any).options.key).toBe('K');
});

test('a connection with no transport of its own still gets one that carries it', () => {
  const Ctor = TestConn as unknown as new (...args: unknown[]) => TestConn;
  const c = new Ctor(
    { url: 'https://h:44300', authType: 'basic' } as any,
    null,
  );

  // The default path: no transport was named, so the connection builds an
  // HttpTransport around its own hook. Reaching for the adapter would prove
  // nothing about the agent, so the transport is asked directly.
  const transport = new HttpTransport(() => (c as any).getHttpsAgentOptions());

  expect((agentOf(transport) as any).options.cert).toBe('C');
});
