/**
 * What the live suites read: `test-config.yaml`, and the session files it points at.
 *
 * Built the way `@mcp-abap-adt/adt-clients` builds its integration tests — a
 * committed template, a git-ignored config made from it, one helper that reads
 * it — and split by provider, because each provider is run on the machine that
 * has its system: basic and token on a developer's, SNC on the Windows machine
 * with the Secure Login Client.
 *
 * Two rules hold everywhere in here:
 *
 *  - A live suite is skipped only when its section is ABSENT. A present section
 *    that fails — an unreachable host, an expired token, a refused session — is
 *    red, and so is a section that is malformed. A skip that hides a fault is
 *    the trap `skipUnlessConfigured` in adt-clients was written to close.
 *  - No secret reaches a message. The config points at session files; an error
 *    names the file or the KEY that is wrong, never a value read from it.
 *
 * Every provider is built explicitly. Nothing is inferred from an auth type.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { AgentOptions } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AuthorizationCodeProvider,
  BasicAuthProvider,
  SncLogonProvider,
} from '@mcp-abap-adt/auth-providers';
import type {
  AuthOutcome,
  IAuthRejection,
} from '@mcp-abap-adt/interfaces-auth';
import * as dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtCloudConnector } from '../../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { CloudHttpTransport } from '../../connection/CloudHttpTransport.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { RfcTransport } from '../../connection/RfcTransport.js';
import { rfcConversationFrom } from '../../connection/rfcConversation.js';

export const CONFIG_PATH = resolve(__dirname, 'test-config.yaml');

export type LiveWire = 'http' | 'rfc';
const WIRES: readonly LiveWire[] = ['http', 'rfc'];

export type LiveSection = Record<string, unknown>;
export type LiveConfig = Record<string, unknown>;

/** The file's mappings, or `{}` when there is no file — a machine with no systems. */
export function readLiveConfig(path: string = CONFIG_PATH): LiveConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    // The parser's message quotes the offending line, which may be a value.
    throw new Error(
      `${path} does not parse as YAML (${error instanceof Error ? error.name : 'error'}) — fix the file; this is a failure, not a skip`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be a mapping of provider sections`);
  }
  return parsed as LiveConfig;
}

/** Skip only for an absent section; say which one and where it is set. */
export function sectionOrSkip(
  config: LiveConfig,
  name: string,
): { section?: LiveSection; reason?: string } {
  const section = config[name];
  if (section === undefined || section === null) {
    return {
      reason: `no "${name}" section in test-config.yaml — no ${name} system to run against here`,
    };
  }
  if (typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(
      `the "${name}" section of test-config.yaml must be a mapping`,
    );
  }
  return { section: section as LiveSection };
}

/**
 * `describe` for one provider's live suite: the body runs when the section is
 * there, and a single skipped case carries the reason when it is not.
 */
export function describeLive(
  name: string,
  body: (section: LiveSection) => void,
  config: LiveConfig = readLiveConfig(),
): void {
  const { section, reason } = sectionOrSkip(config, name);
  if (!section) {
    describe(`live: ${name}`, () => {
      it.skip(`skipped — ${reason}`, () => undefined);
    });
    process.stderr.write(`[live:${name}] skipped — ${reason}\n`);
    return;
  }
  describe(`live: ${name}`, () => body(section));
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/')
    ? join(homedir(), path.slice(1))
    : path;
}

/** A session file's KEY=VALUE lines. The values are never printed. */
export function readEnvFile(path: string): Record<string, string> {
  const real = expandHome(path);
  if (!existsSync(real)) {
    throw new Error(`env file ${real} does not exist`);
  }
  return dotenv.parse(readFileSync(real, 'utf8'));
}

export function requireKeys(
  env: Record<string, string>,
  keys: readonly string[],
  file: string,
): void {
  const missing = keys.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`env file ${file} lacks: ${missing.join(', ')}`);
  }
}

function text(section: LiveSection, key: string, name: string): string {
  const value = section[key];
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /^<.*>$/.test(value.trim())
  ) {
    throw new Error(
      `test-config.yaml: "${name}.${key}" must be set to a real value (it is missing or still a <PLACEHOLDER>)`,
    );
  }
  return value.trim();
}

function optionalText(
  section: LiveSection,
  key: string,
  name: string,
): string | undefined {
  const value = section[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`test-config.yaml: "${name}.${key}" must be text`);
  }
  return String(value).trim() || undefined;
}

export interface RfcOverrides {
  ashost?: string;
  sysnr?: string;
}

function rfcOverrides(section: LiveSection, name: string): RfcOverrides {
  return {
    ashost: optionalText(section, 'ashost', name),
    sysnr: optionalText(section, 'sysnr', name),
  };
}

export interface BasicSetup {
  config: SapConfig;
  wires: LiveWire[];
  rfc: RfcOverrides;
  rejectUnauthorized: boolean;
  /** The real password plus a suffix: refused, and one attempt per wire. */
  wrongPassword: string;
  readClass: string;
  lockClass?: string;
  provider(): BasicAuthProvider;
  wrongProvider(): BasicAuthProvider;
}

export function basicSection(section: LiveSection): BasicSetup {
  const file = text(section, 'env_file', 'basic');
  const wires = section.wires;
  if (!Array.isArray(wires) || wires.length === 0) {
    throw new Error(
      'test-config.yaml: "basic.wires" must list at least one of http, rfc',
    );
  }
  for (const wire of wires) {
    if (!WIRES.includes(wire as LiveWire)) {
      throw new Error(
        `test-config.yaml: "basic.wires" has "${String(wire)}" — only http and rfc exist`,
      );
    }
  }
  const env = readEnvFile(file);
  requireKeys(
    env,
    ['SAP_URL', 'SAP_CLIENT', 'SAP_USERNAME', 'SAP_PASSWORD'],
    file,
  );
  const username = env.SAP_USERNAME;
  const password = env.SAP_PASSWORD;
  return {
    config: {
      url: env.SAP_URL,
      client: env.SAP_CLIENT,
      username,
      password,
      authType: 'basic',
    },
    wires: wires as LiveWire[],
    rfc: rfcOverrides(section, 'basic'),
    rejectUnauthorized: env.TLS_REJECT_UNAUTHORIZED?.trim() !== 'false',
    wrongPassword: `${password}x`,
    readClass:
      optionalText(section, 'read_class', 'basic') ?? DEFAULT_READ_CLASS,
    lockClass: optionalText(section, 'lock_class', 'basic'),
    provider: () => new BasicAuthProvider(username, password),
    wrongProvider: () => new BasicAuthProvider(username, `${password}x`),
  };
}

export const DEFAULT_READ_CLASS = 'CL_ABAP_TYPEDESCR';

export interface TokenSetup {
  config: SapConfig;
  tokens: {
    accessToken: string;
    refreshToken: string;
    uaaUrl: string;
    clientId: string;
    clientSecret: string;
  };
  rejectUnauthorized: boolean;
}

export function tokenSection(section: LiveSection): TokenSetup {
  const file = text(section, 'env_file', 'token');
  const env = readEnvFile(file);
  requireKeys(
    env,
    [
      'SAP_URL',
      'SAP_JWT_TOKEN',
      'SAP_REFRESH_TOKEN',
      'SAP_UAA_URL',
      'SAP_UAA_CLIENT_ID',
      'SAP_UAA_CLIENT_SECRET',
    ],
    file,
  );
  return {
    config: {
      url: env.SAP_URL,
      client: env.SAP_CLIENT?.trim() || undefined,
      authType: 'jwt',
    },
    tokens: {
      accessToken: env.SAP_JWT_TOKEN,
      refreshToken: env.SAP_REFRESH_TOKEN,
      uaaUrl: env.SAP_UAA_URL,
      clientId: env.SAP_UAA_CLIENT_ID,
      clientSecret: env.SAP_UAA_CLIENT_SECRET,
    },
    rejectUnauthorized: env.TLS_REJECT_UNAUTHORIZED?.trim() !== 'false',
  };
}

export interface SncSetup {
  config: SapConfig;
  snc: { partnerName: string; qop?: string; sncLib?: string; myName?: string };
  rfc: RfcOverrides;
  readClass: string;
}

export function sncSection(section: LiveSection): SncSetup {
  const partnerName = text(section, 'partner_name', 'snc');
  return {
    config: {
      url: text(section, 'url', 'snc'),
      client: text(section, 'client', 'snc'),
      authType: 'snc',
    },
    snc: {
      partnerName,
      qop: optionalText(section, 'qop', 'snc'),
      sncLib: optionalText(section, 'snc_lib', 'snc'),
      myName: optionalText(section, 'my_name', 'snc'),
    },
    rfc: rfcOverrides(section, 'snc'),
    readClass: optionalText(section, 'read_class', 'snc') ?? DEFAULT_READ_CLASS,
  };
}

export function sncProvider(setup: SncSetup): SncLogonProvider {
  return SncLogonProvider.forSecureLoginClient(setup.snc);
}

/**
 * A JWT-shaped access token that no system accepts: the payload says it is good
 * for an hour, so the provider presents it rather than renewing it up front,
 * and the signature is nothing, so the system answers 401. That is the road the
 * renewal takes at run time — refused on a request, then `rejected()`.
 */
export function invalidAccessToken(): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    part({ alg: 'RS256', typ: 'JWT' }),
    part({
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
    'not-a-signature',
  ].join('.');
}

/** A token provider seeded from the session, whose interactive login is refused. */
export class RenewalOnlyTokenProvider extends AuthorizationCodeProvider {
  /** How many times the connection asked this provider what to do about a refusal. */
  rejections = 0;

  constructor(tokens: TokenSetup['tokens'], accessToken = tokens.accessToken) {
    super({
      uaaUrl: tokens.uaaUrl,
      clientId: tokens.clientId,
      clientSecret: tokens.clientSecret,
      accessToken,
      refreshToken: tokens.refreshToken,
      // Renewal is by refresh token only. A refresh the UAA refuses must fail
      // the suite, not open a browser on a machine nobody is sitting at.
      authorization: {
        authorize: async () => {
          throw new Error(
            'interactive login is refused in the live suite — the session file holds no usable refresh token',
          );
        },
      },
    });
  }

  override async rejected(rejection: IAuthRejection): Promise<AuthOutcome> {
    this.rejections++;
    return super.rejected(rejection);
  }
}

const agentOptions = (rejectUnauthorized: boolean) => (): AgentOptions =>
  rejectUnauthorized ? {} : { rejectUnauthorized: false };

/**
 * The RFC factory with the section's `ashost` / `sysnr` laid over what the URL
 * gives. `rfcConversationFrom` spreads the logon record over the parameters it
 * derived, so overrides put in the record win — no change to the library, and
 * nothing set in the process environment.
 */
export function rfcTransportFor(config: SapConfig, overrides: RfcOverrides) {
  const open = rfcConversationFrom(config);
  const pinned: Record<string, string> = {};
  if (overrides.ashost) pinned.ashost = overrides.ashost;
  if (overrides.sysnr) pinned.sysnr = overrides.sysnr;
  return new RfcTransport((logon) => open({ ...logon, ...pinned }));
}

export function onPremOver(
  wire: LiveWire,
  config: SapConfig,
  provider: BasicAuthProvider,
  rfc: RfcOverrides,
  rejectUnauthorized: boolean,
) {
  if (wire === 'rfc') {
    return new AdtOnPremConnector(
      config,
      provider,
      rfcTransportFor(config, rfc),
    );
  }
  return new AdtOnPremConnector(
    config,
    provider,
    new OnPremHttpTransport(agentOptions(rejectUnauthorized), null, {
      client: config.client,
      baseUrl: config.url,
    }),
  );
}

export function snc(setup: SncSetup) {
  return new AdtOnPremConnector(
    setup.config,
    sncProvider(setup),
    rfcTransportFor(setup.config, setup.rfc),
  );
}

export function cloudOver(
  config: SapConfig,
  provider: RenewalOnlyTokenProvider,
  rejectUnauthorized: boolean,
) {
  return new AdtCloudConnector(
    config,
    provider,
    new CloudHttpTransport(agentOptions(rejectUnauthorized), null, {
      client: config.client,
      baseUrl: config.url,
    }),
  );
}

export function classSourceUrl(name: string): string {
  return `/sap/bc/adt/oo/classes/${encodeURIComponent(name.toLowerCase())}/source/main`;
}

export function classUrl(name: string): string {
  return `/sap/bc/adt/oo/classes/${encodeURIComponent(name.toLowerCase())}`;
}
