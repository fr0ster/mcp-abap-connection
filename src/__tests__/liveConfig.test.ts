/**
 * The live-suite config helper, tested without a system: what it reads, when
 * it says "skip", and that no error names a secret it read.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  basicSection,
  expandHome,
  invalidAccessToken,
  readEnvFile,
  readLiveConfig,
  requireKeys,
  rfcTransportFor,
  sectionOrSkip,
  sncSection,
  tokenSection,
} from './helpers/liveConfig.js';

const dialed: Array<Record<string, string>> = [];
jest.mock(
  '@mcp-abap-adt/sap-rfc-lite',
  () => ({
    Client: class {
      constructor(params: Record<string, string>) {
        dialed.push(params);
      }
    },
  }),
  { virtual: true },
);

describe('liveConfig', () => {
  // Made when the file is collected: the `describe` bodies below write their
  // session files while they are being registered, before any hook runs.
  const dir = mkdtempSync(join(tmpdir(), 'live-config-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  describe('readLiveConfig', () => {
    it('is empty when there is no config file — the machine has no systems', () => {
      expect(readLiveConfig(join(dir, 'absent.yaml'))).toStrictEqual({});
    });

    it('reads the sections it finds', () => {
      const path = write(
        'c.yaml',
        'basic:\n  env_file: a.env\n  wires: [http]\n',
      );
      expect(readLiveConfig(path).basic).toStrictEqual({
        env_file: 'a.env',
        wires: ['http'],
      });
    });

    it('a config that does not parse is an error, not an empty config', () => {
      const path = write('c.yaml', 'basic: [unclosed\n');
      expect(() => readLiveConfig(path)).toThrow(/c\.yaml/);
    });

    it('a config that is not a mapping is an error', () => {
      const path = write('c.yaml', '- a\n- b\n');
      expect(() => readLiveConfig(path)).toThrow(/mapping/);
    });
  });

  describe('sectionOrSkip', () => {
    it('skips only when the section is absent, and says which', () => {
      const decision = sectionOrSkip({}, 'snc');
      expect(decision.section).toBeUndefined();
      expect(decision.reason).toMatch(/snc/);
      expect(decision.reason).toMatch(/test-config\.yaml/);
    });

    it('does not skip a present section', () => {
      const decision = sectionOrSkip({ snc: { url: 'x' } }, 'snc');
      expect(decision.section).toStrictEqual({ url: 'x' });
      expect(decision.reason).toBeUndefined();
    });

    it('a present section that is not a mapping is an error, not a skip', () => {
      expect(() => sectionOrSkip({ snc: 'oops' }, 'snc')).toThrow(/snc/);
    });
  });

  describe('expandHome / readEnvFile', () => {
    it('expands a leading ~ to the home directory and only there', () => {
      expect(expandHome('~/x/y.env')).toBe(join(homedir(), 'x/y.env'));
      expect(expandHome('/a/~/b')).toBe('/a/~/b');
    });

    it('reads KEY=VALUE lines through ~', () => {
      const path = write('s.env', 'SAP_URL=https://h:44300\nSAP_CLIENT=100\n');
      expect(readEnvFile(path)).toMatchObject({
        SAP_URL: 'https://h:44300',
        SAP_CLIENT: '100',
      });
    });

    it('a missing env file names the path, not any content', () => {
      expect(() => readEnvFile(join(dir, 'nope.env'))).toThrow(/nope\.env/);
    });
  });

  describe('requireKeys', () => {
    it('names the missing key and never a value', () => {
      const env = { SAP_URL: 'https://h', SAP_PASSWORD: 'hunter2-secret' };
      let message = '';
      try {
        requireKeys(env, ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD'], 'a.env');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/SAP_USERNAME/);
      expect(message).toMatch(/a\.env/);
      expect(message).not.toMatch(/hunter2/);
      expect(message).not.toMatch(/https:\/\/h/);
    });

    it('is quiet when every key is present', () => {
      expect(() => requireKeys({ A: '1' }, ['A'], 'a.env')).not.toThrow();
    });

    it('an empty value is missing', () => {
      expect(() => requireKeys({ A: ' ' }, ['A'], 'a.env')).toThrow(/A/);
    });
  });

  describe('basicSection', () => {
    const env = write(
      'b.env',
      'SAP_URL=https://h:44300\nSAP_CLIENT=100\nSAP_USERNAME=dev\nSAP_PASSWORD=s3cret\n',
    );

    it('builds the config from the session file and keeps the wires', () => {
      const built = basicSection({
        env_file: env,
        wires: ['http', 'rfc'],
        ashost: 'localhost',
        sysnr: '00',
      });
      expect(built.config).toMatchObject({
        url: 'https://h:44300',
        client: '100',
        username: 'dev',
        authType: 'basic',
      });
      expect(built.wires).toStrictEqual(['http', 'rfc']);
      expect(built.rfc).toStrictEqual({ ashost: 'localhost', sysnr: '00' });
      expect(built.rejectUnauthorized).toBe(true);
    });

    it('TLS_REJECT_UNAUTHORIZED=false turns verification off', () => {
      const off = write(
        'off.env',
        'SAP_URL=https://h\nSAP_CLIENT=100\nSAP_USERNAME=dev\nSAP_PASSWORD=p\nTLS_REJECT_UNAUTHORIZED=false\n',
      );
      expect(
        basicSection({ env_file: off, wires: ['http'] }).rejectUnauthorized,
      ).toBe(false);
    });

    it('an unknown wire is an error naming it', () => {
      expect(() =>
        basicSection({ env_file: env, wires: ['http', 'smtp'] }),
      ).toThrow(/smtp/);
    });

    it('no wires is an error', () => {
      expect(() => basicSection({ env_file: env, wires: [] })).toThrow(/wires/);
    });

    it('a missing env_file key is an error naming the field', () => {
      expect(() => basicSection({ wires: ['http'] })).toThrow(/env_file/);
    });

    it('a session file without the password fails without printing what it has', () => {
      const thin = write(
        'thin.env',
        'SAP_URL=https://h\nSAP_CLIENT=100\nSAP_USERNAME=dev\n',
      );
      expect(() => basicSection({ env_file: thin, wires: ['http'] })).toThrow(
        /SAP_PASSWORD/,
      );
    });

    it('the wrong password is the real one plus a suffix, never the real one', () => {
      const built = basicSection({ env_file: env, wires: ['http'] });
      expect(built.wrongPassword).toBe('s3cretx');
    });
  });

  describe('tokenSection', () => {
    it('reads the token, the refresh token and the UAA client', () => {
      const env = write(
        't.env',
        [
          'SAP_URL=https://t.example',
          'SAP_JWT_TOKEN=at',
          'SAP_REFRESH_TOKEN=rt',
          'SAP_UAA_URL=https://uaa',
          'SAP_UAA_CLIENT_ID=cid',
          'SAP_UAA_CLIENT_SECRET=csec',
        ].join('\n'),
      );
      const built = tokenSection({ env_file: env });
      expect(built.config.url).toBe('https://t.example');
      expect(built.tokens).toStrictEqual({
        accessToken: 'at',
        refreshToken: 'rt',
        uaaUrl: 'https://uaa',
        clientId: 'cid',
        clientSecret: 'csec',
      });
    });

    it('a missing refresh token names its key', () => {
      const env = write(
        't2.env',
        'SAP_URL=https://t\nSAP_JWT_TOKEN=at\nSAP_UAA_URL=u\nSAP_UAA_CLIENT_ID=c\nSAP_UAA_CLIENT_SECRET=s\n',
      );
      expect(() => tokenSection({ env_file: env })).toThrow(
        /SAP_REFRESH_TOKEN/,
      );
    });
  });

  describe('sncSection', () => {
    it('takes its values from the section itself', () => {
      const built = sncSection({
        url: 'http://h:8000',
        client: '001',
        partner_name: 'p:CN=X',
        qop: '3',
      });
      expect(built.config).toMatchObject({
        url: 'http://h:8000',
        client: '001',
        authType: 'snc',
      });
      expect(built.snc).toMatchObject({ partnerName: 'p:CN=X', qop: '3' });
    });

    it('a missing partner_name is an error naming the field', () => {
      expect(() => sncSection({ url: 'http://h', client: '001' })).toThrow(
        /partner_name/,
      );
    });
  });

  describe('invalidAccessToken', () => {
    it('looks like a live JWT (so it is presented) and is not one the system accepts', () => {
      const token = invalidAccessToken();
      const [, payload] = token.split('.');
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      expect(exp * 1000).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('rfcTransportFor', () => {
    const config = {
      url: 'http://tunnel:50400',
      client: '100',
      authType: 'basic' as const,
    };
    const open = (overrides: { ashost?: string; sysnr?: string }) => {
      dialed.length = 0;
      const transport = rfcTransportFor(config, overrides);
      // The factory is the transport's constructor argument.
      (
        transport as unknown as { connect(l: Record<string, string>): unknown }
      ).connect({ user: 'u' });
      return dialed[0];
    };

    it("the section's ashost and sysnr win over what the URL gives", () => {
      expect(open({ ashost: 'appserver', sysnr: '07' })).toMatchObject({
        ashost: 'appserver',
        sysnr: '07',
        client: '100',
        user: 'u',
      });
    });

    it('without overrides the URL still names the host', () => {
      expect(open({})).toMatchObject({ ashost: 'tunnel' });
    });
  });
});
