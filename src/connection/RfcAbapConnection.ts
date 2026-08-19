import { randomUUID } from 'node:crypto';
import type {
  IAbapRequestOptions,
  IAdtResponse,
} from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { AbapConnection } from './AbapConnection.js';

function rfcErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') return JSON.stringify(e);
  return String(e);
}

/**
 * RFC connection parameters for @mcp-abap-adt/sap-rfc-lite Client
 */
interface RfcConnectionParams {
  ashost: string;
  sysnr: string;
  client: string;
  user: string;
  passwd: string;
  lang: string;
}

/**
 * Minimal interface for @mcp-abap-adt/sap-rfc-lite Client to avoid hard dependency
 */
interface IRfcClient {
  open(): Promise<void>;
  close(): Promise<void>;
  call(
    functionModule: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>>;
  readonly alive: boolean;
}

/**
 * Derive RFC connection parameters from ISapConfig.
 * Parses hostname from config.url, system number from port (80XX → XX).
 *
 * Examples:
 *   http://saphost:8000  → ashost=saphost, sysnr=00
 *   http://saphost:8001  → ashost=saphost, sysnr=01
 *   http://saphost:8042  → ashost=saphost, sysnr=42
 */
function buildRfcParams(config: SapConfig): RfcConnectionParams {
  const parsed = new URL(config.url);

  const port = Number.parseInt(parsed.port || '8000', 10);
  // SAP HTTP port convention: 80XX where XX = system number.
  // SAP_SYSNR env var overrides derivation for non-standard ports (e.g. 50400).
  const derivedSysnr = String(port - 8000).padStart(2, '0');
  const sysnr = process.env.SAP_SYSNR?.trim() || derivedSysnr;

  return {
    ashost: parsed.hostname,
    sysnr,
    client: config.client || '000',
    user: config.username || '',
    passwd: config.password || '',
    lang: 'EN',
  };
}

/**
 * Map ADT exception type names to HTTP status codes.
 * These are standard ADT exception types returned in `<exc:exception>` XML.
 */
const EXCEPTION_STATUS_MAP: Record<string, { code: number; text: string }> = {
  ExceptionResourceNotFound: { code: 404, text: 'Not Found' },
  ExceptionResourceNoAuthorization: { code: 403, text: 'Forbidden' },
  ExceptionResourceAlreadyExists: { code: 409, text: 'Conflict' },
  ExceptionResourceLocked: { code: 423, text: 'Locked' },
  ExceptionBadRequest: { code: 400, text: 'Bad Request' },
  ExceptionNotSupported: { code: 501, text: 'Not Implemented' },
  ExceptionConflict: { code: 409, text: 'Conflict' },
};

/**
 * Detect HTTP status from ADT exception XML in response body.
 * On some legacy systems, SADT_REST_RFC_ENDPOINT returns errors as XML
 * exceptions without setting proper HTTP status codes in STATUS_LINE.
 */
function detectExceptionStatus(body: string): {
  statusCode: number;
  statusText: string;
} {
  // Extract exception type: <exc:exception ... xmlns:exc="..."><exc:type>ExceptionName</exc:type>
  const typeMatch = body.match(/<exc:type[^>]*>([^<]+)<\/exc:type>/);
  if (typeMatch) {
    const exType = typeMatch[1].trim();
    const mapped = EXCEPTION_STATUS_MAP[exType];
    if (mapped) {
      return { statusCode: mapped.code, statusText: mapped.text };
    }
  }

  // Unknown exception type — return 500 as generic server error
  return { statusCode: 500, statusText: 'Internal Server Error' };
}

/**
 * RFC-based connection for on-premise SAP systems.
 *
 * Uses @mcp-abap-adt/sap-rfc-lite to call SADT_REST_RFC_ENDPOINT — the same standard SAP FM
 * that Eclipse ADT uses for all on-premise ADT operations via JCo.
 *
 * RFC connections are inherently stateful: one ABAP session persists for the
 * entire connection lifetime. This solves the HTTP 423 "invalid lock handle"
 * problem on legacy systems (BASIS < 7.50) where HTTP stateful sessions
 * are not supported.
 *
 * Connection parameters are derived from the standard ISapConfig.url field:
 *   http://saphost:8000 → ashost=saphost, sysnr=00
 *
 * Prerequisites:
 *   - SAP NW RFC SDK installed on the machine
 *   - @mcp-abap-adt/sap-rfc-lite package installed: npm install @mcp-abap-adt/sap-rfc-lite
 */
export class RfcAbapConnection implements AbapConnection {
  private rfcClient: IRfcClient | null = null;
  private readonly sessionId: string;
  private readonly baseUrl: string;
  private readonly rfcParams: RfcConnectionParams;
  private sessionType: 'stateful' | 'stateless' = 'stateless';
  private sessionCookie: string | null = null;

  constructor(
    private readonly config: SapConfig,
    private readonly logger: ILogger | null = null,
  ) {
    RfcAbapConnection.validateConfig(config);

    this.sessionId = randomUUID();
    this.baseUrl = config.url;
    this.rfcParams = buildRfcParams(config);

    this.logger?.debug(
      `RfcAbapConnection created for ${this.rfcParams.ashost}:${this.rfcParams.sysnr}, client ${this.rfcParams.client}`,
    );
  }

  async connect(): Promise<void> {
    let Client: new (params: RfcConnectionParams) => IRfcClient;
    try {
      // Dynamic require — @mcp-abap-adt/sap-rfc-lite is NOT a declared dependency.
      // Users who need RFC connections must install it manually:
      //   npm install @mcp-abap-adt/sap-rfc-lite (+ SAP NW RFC SDK on the machine)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const noderfc = require('@mcp-abap-adt/sap-rfc-lite');
      Client = noderfc.Client;
    } catch (e) {
      throw new Error(
        '@mcp-abap-adt/sap-rfc-lite is not available. To use RFC connections, install SAP NW RFC SDK ' +
          'and run: npm install @mcp-abap-adt/sap-rfc-lite. ' +
          `Details: ${rfcErrorMessage(e)}`,
      );
    }

    this.rfcClient = new Client(this.rfcParams);

    try {
      await this.rfcClient.open();
      this.logger?.debug('RFC connection opened (stateful session)');
    } catch (e) {
      this.rfcClient = null;
      const msg = rfcErrorMessage(e);
      this.logger?.error(`RFC connection failed: ${msg}`);
      throw new Error(`Failed to open RFC connection: ${msg}`);
    }
  }

  async getBaseUrl(): Promise<string> {
    return this.baseUrl;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionType(type: 'stateful' | 'stateless'): void {
    this.sessionType = type;
    if (type === 'stateless') {
      this.sessionCookie = null;
      this.logger?.debug('RFC session type: stateless (cookie cleared)');
    } else {
      this.logger?.debug('RFC session type: stateful (will capture cookies)');
    }
  }

  async makeAdtRequest<T = any, D = any>(
    options: IAbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    if (!this.rfcClient?.alive) {
      throw new Error('RFC connection is not open. Call connect() first.');
    }

    const method = options.method.toUpperCase();

    // Encode query params into URI (axios does this automatically for HTTP,
    // but RFC needs it done manually)
    let uri = options.url;
    if (options.params && typeof options.params === 'object') {
      const entries = Object.entries(
        options.params as Record<string, string | number | boolean>,
      ).filter(([, v]) => v !== undefined && v !== null);
      if (entries.length > 0) {
        const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
        uri += (uri.includes('?') ? '&' : '?') + qs.toString();
      }
    }

    // Note: sap-client is NOT added to URI for RFC connections.
    // The RFC session is already logged into the correct client
    // (via the 'client' param in RFC connection). Adding sap-client
    // to the URI can cause "object not found" on some systems.

    // Build header fields
    const headerFields: Array<{ NAME: string; VALUE: string }> = [];
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        headerFields.push({ NAME: name, VALUE: value });
      }
    }

    // Inject session type header so SAP creates/maintains an ICM session
    if (this.sessionType === 'stateful') {
      headerFields.push({ NAME: 'x-sap-adt-sessiontype', VALUE: 'stateful' });
    }

    // Replay session cookie for stateful operations (cookie captured from LOCK response)
    if (this.sessionCookie) {
      const existingCookie = headerFields.find(
        (h) => h.NAME.toLowerCase() === 'cookie',
      );
      if (!existingCookie) {
        headerFields.push({ NAME: 'Cookie', VALUE: this.sessionCookie });
      }
    }

    // Ensure Content-Type for body
    const body =
      options.data !== undefined && options.data !== null
        ? String(options.data)
        : '';

    if (
      body &&
      !headerFields.some((h) => h.NAME.toLowerCase() === 'content-type')
    ) {
      headerFields.push({
        NAME: 'Content-Type',
        VALUE: 'text/plain; charset=utf-8',
      });
    }

    this.logger?.debug(`RFC → ${method} ${uri}`);
    this.logger?.debug(`RFC → headers: ${JSON.stringify(headerFields)}`);
    if (body) this.logger?.debug(`RFC → body: ${body}`);

    try {
      const result = await this.rfcClient.call('SADT_REST_RFC_ENDPOINT', {
        REQUEST: {
          REQUEST_LINE: {
            METHOD: method,
            URI: uri,
            VERSION: 'HTTP/1.1',
          },
          HEADER_FIELDS: headerFields,
          MESSAGE_BODY: body ? Buffer.from(body, 'utf-8') : Buffer.alloc(0),
        },
      });

      const resp = result.RESPONSE || result;

      // Log raw RFC response structure for debugging
      this.logger?.debug(
        `RFC raw response keys: ${Object.keys(resp).join(', ')}`,
      );
      if (resp.STATUS_LINE) {
        this.logger?.debug(
          `RFC STATUS_LINE: ${JSON.stringify(resp.STATUS_LINE)}`,
        );
      }

      // Parse status — RFC returns status in STATUS_LINE structure
      // Field names: STATUS_CODE (not CODE), REASON_PHRASE (not REASON)
      const rawCode =
        resp.STATUS_LINE?.STATUS_CODE || resp.STATUS_LINE?.CODE || 0;
      let statusCode =
        typeof rawCode === 'string' ? Number.parseInt(rawCode, 10) : rawCode;
      let statusText =
        resp.STATUS_LINE?.REASON_PHRASE || resp.STATUS_LINE?.REASON || '';

      // Parse response body
      const respBody = resp.MESSAGE_BODY
        ? Buffer.isBuffer(resp.MESSAGE_BODY)
          ? resp.MESSAGE_BODY.toString('utf-8')
          : String(resp.MESSAGE_BODY)
        : '';

      // Parse response headers
      const respHeaders: Record<string, any> = {};
      const respHeaderFields = resp.HEADER_FIELDS || [];
      for (const field of respHeaderFields) {
        if (field.NAME && field.VALUE !== undefined) {
          respHeaders[field.NAME.toLowerCase()] = field.VALUE;
        }
      }

      // Capture session cookie from LOCK/stateful responses for cookie replay
      if (this.sessionType === 'stateful' && respHeaders['set-cookie']) {
        const setCookieHeader = respHeaders['set-cookie'];
        // Extract cookie name=value pairs (strip attributes like Path, Secure, etc.)
        const cookies = Array.isArray(setCookieHeader)
          ? setCookieHeader
          : [setCookieHeader];
        const cookieValues = cookies
          .map((c: string) => c.split(';')[0].trim())
          .filter(Boolean);
        if (cookieValues.length > 0) {
          this.sessionCookie = cookieValues.join('; ');
          this.logger?.debug(
            `RFC: captured session cookie: ${this.sessionCookie}`,
          );
        }
      }

      // On some systems (e.g. BASIS < 7.50), SADT_REST_RFC_ENDPOINT does not
      // populate STATUS_LINE, returning status 0. Detect errors from the
      // response body: ADT exception XML indicates a failed request.
      if (!statusCode && respBody.includes('<exc:exception')) {
        const detected = detectExceptionStatus(respBody);
        statusCode = detected.statusCode;
        statusText = detected.statusText;
        this.logger?.debug(
          `RFC: STATUS_LINE empty, detected ${statusCode} from exception XML`,
        );
      }

      // Default to 200 OK only when no error was detected
      if (!statusCode) {
        statusCode = 200;
        statusText = statusText || 'OK';
      }

      this.logger?.debug(
        `RFC ← ${statusCode} ${statusText} (${respBody.length} bytes)`,
      );
      this.logger?.debug(`RFC ← headers: ${JSON.stringify(respHeaders)}`);
      if (respBody) this.logger?.debug(`RFC ← body: ${respBody}`);

      const response: IAdtResponse<T, D> = {
        data: respBody as unknown as T,
        status: statusCode,
        statusText,
        headers: respHeaders,
      };

      // Throw for error status codes (matching HTTP/axios behavior)
      if (statusCode >= 400) {
        const error = new Error(
          `Request failed with status ${statusCode}: ${method} ${uri}`,
        );
        (error as any).response = response;
        throw error;
      }

      return response;
    } catch (e) {
      // Re-throw our own errors (status >= 400)
      if ((e as any)?.response) {
        throw e;
      }

      // RFC-level error
      const msg = rfcErrorMessage(e);
      this.logger?.error(`RFC call failed: ${msg}`);
      throw new Error(`RFC call to SADT_REST_RFC_ENDPOINT failed: ${msg}`);
    }
  }

  /**
   * Reset the connection — for RFC this closes the session.
   * Provides interface compatibility with HTTP connections.

  /**
   * Close the RFC connection and release the ABAP session.
   */
  async close(): Promise<void> {
    if (this.rfcClient) {
      try {
        await this.rfcClient.close();
        this.logger?.debug('RFC connection closed');
      } catch (e) {
        this.logger?.debug(`RFC close error: ${rfcErrorMessage(e)}`);
      }
      this.rfcClient = null;
    }
  }

  private static validateConfig(config: SapConfig): void {
    if (config.connectionType !== 'rfc') {
      throw new Error(
        `RFC connection expects connectionType "rfc", got "${config.connectionType}"`,
      );
    }

    if (!config.url) {
      throw new Error(
        'RFC connection requires url (hostname is parsed from it)',
      );
    }

    if (!config.username || !config.password) {
      throw new Error('RFC connection requires both username and password');
    }

    if (!config.client) {
      throw new Error('RFC connection requires SAP client');
    }
  }
}
