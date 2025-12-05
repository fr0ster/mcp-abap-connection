import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { Agent } from "https";
import { randomUUID } from "crypto";
import { ILogger, ISessionStorage, SessionState } from "../logger.js";
import { getTimeout } from "../utils/timeouts.js";
import { SapConfig } from "../config/sapConfig.js";
import { AbapConnection, AbapRequestOptions } from "./AbapConnection.js";
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from "./csrfConfig.js";

abstract class AbstractAbapConnection implements AbapConnection {
  private axiosInstance: AxiosInstance | null = null;
  private csrfToken: string | null = null;
  private cookies: string | null = null;
  private cookieStore: Map<string, string> = new Map();
  private baseUrl: string;
  private sessionId: string | null = null;
  private sessionStorage: ISessionStorage | null = null;
  private sessionMode: "stateless" | "stateful" = "stateless";

  protected constructor(
    private readonly config: SapConfig,
    protected readonly logger: ILogger,
    sessionStorage?: ISessionStorage,
    sessionId?: string
  ) {
    this.sessionStorage = sessionStorage || null;
    // Always generate sessionId (used for sap-adt-connection-id header in all session types)
    this.sessionId = sessionId || randomUUID();
    // Session mode depends only on storage availability (sessionId exists for both modes)
    this.sessionMode = sessionStorage ? "stateful" : "stateless";
    
    // Initialize baseUrl from config (required, will throw if invalid)
    try {
      const urlObj = new URL(config.url);
      this.baseUrl = urlObj.origin;
    } catch (error) {
      throw new Error(`Invalid URL in configuration: ${error instanceof Error ? error.message : error}`);
    }
    
    this.logger.debug(`AbstractAbapConnection - Session ID: ${this.sessionId.substring(0, 8)}..., mode: ${this.sessionMode}`);
  }

  /**
   * Set session type (stateful or stateless)
   * Controls whether x-sap-adt-sessiontype: stateful header is added to requests
   * - stateful: SAP maintains session state between requests (locks, transactions)
   * - stateless: Each request is independent
   */
  setSessionType(type: "stateful" | "stateless"): void {
    this.sessionMode = type;
    this.logger.debug(`Session type set to: ${type}`, {
      sessionId: this.sessionId?.substring(0, 8),
      hasStorage: !!this.sessionStorage
    });
  }

  /**
   * Enable stateful session mode (tells SAP to maintain stateful session)
   * This controls whether x-sap-adt-sessiontype: stateful header is used
   * Storage is controlled separately via setSessionStorage()
   * @deprecated Use setSessionType("stateful") instead
   */
  enableStatefulSession(): void {
    this.setSessionType("stateful");
  }

  /**
   * Disable stateful session mode (switch to stateless)
   * Optionally saves current state before switching
   * @deprecated Use setSessionType("stateless") instead
   */
  async disableStatefulSession(saveBeforeDisable: boolean = false): Promise<void> {
    if (this.sessionMode === "stateless") {
      return;
    }

    if (saveBeforeDisable && this.sessionId && this.sessionStorage) {
      await this.saveSessionState();
    }

    this.sessionMode = "stateless";

    this.logger.debug("Stateful session mode disabled", {
      savedBeforeDisable: saveBeforeDisable
    });
  }

  /**
   * Get current session mode
   */
  getSessionMode(): "stateless" | "stateful" {
    return this.sessionMode;
  }

  /**
   * Set session ID for stateful operations
   * When session ID is set, session state (cookies, CSRF token) will be persisted
   * @deprecated Use enableStatefulSession() instead
   */
  setSessionId(sessionId: string): void {
    if (this.sessionStorage) {
      this.sessionId = sessionId;
      this.sessionMode = "stateful";
    } else {
      this.logger.warn("Cannot set session ID without session storage. Use enableStatefulSession() instead.");
    }
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set session storage (can be changed at runtime)
   * This controls whether session state (cookies, CSRF token) is persisted to disk/storage
   */
  async setSessionStorage(storage: ISessionStorage | null): Promise<void> {
    this.sessionStorage = storage;
    
    // Load existing session state if storage is provided
    if (storage && this.sessionId) {
      await this.loadSessionState();
    }
    
    this.logger.debug("Session storage configured", {
      hasStorage: !!storage,
      sessionMode: this.sessionMode
    });
  }

  /**
   * Get current session storage
   */
  getSessionStorage(): ISessionStorage | null {
    return this.sessionStorage;
  }

  /**
   * Load session state from storage
   */
  async loadSessionState(): Promise<void> {
    if (!this.sessionId || !this.sessionStorage) {
      return;
    }

    try {
      const state = await this.sessionStorage.load(this.sessionId);
      if (state) {
        this.csrfToken = state.csrfToken;
        this.cookies = state.cookies;
        this.cookieStore = new Map(Object.entries(state.cookieStore));
        this.logger.debug("Session state loaded", {
          sessionId: this.sessionId,
          hasCookies: !!this.cookies,
          hasCsrfToken: !!this.csrfToken
        });
      }
    } catch (error) {
      this.logger.warn("Failed to load session state", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Save session state to storage
   * Only saves if in stateful mode
   */
  async saveSessionState(): Promise<void> {
    if (this.sessionMode !== "stateful" || !this.sessionId || !this.sessionStorage) {
      return;
    }

    try {
      const state: SessionState = {
        cookies: this.cookies,
        csrfToken: this.csrfToken,
        cookieStore: Object.fromEntries(this.cookieStore)
      };
      await this.sessionStorage.save(this.sessionId, state);
      this.logger.debug("Session state saved", {
        sessionId: this.sessionId,
        hasCookies: !!this.cookies,
        hasCsrfToken: !!this.csrfToken
      });
    } catch (error) {
      this.logger.warn("Failed to save session state", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get current session state
   * Returns cookies, CSRF token, and cookie store for manual persistence
   * @returns Current session state or null if no session data
   */
  getSessionState(): SessionState | null {
    if (!this.cookies && !this.csrfToken) {
      return null;
    }

    return {
      cookies: this.cookies,
      csrfToken: this.csrfToken,
      cookieStore: Object.fromEntries(this.cookieStore)
    };
  }

  /**
   * Set session state manually
   * Allows user to restore session from custom storage (e.g., database, Redis)
   * @param state - Session state with cookies, CSRF token, and cookie store
   */
  setSessionState(state: SessionState): void {
    this.cookies = state.cookies || null;
    this.csrfToken = state.csrfToken || null;
    this.cookieStore = new Map(Object.entries(state.cookieStore || {}));

    this.logger.debug("Session state set manually", {
      hasCookies: !!this.cookies,
      hasCsrfToken: !!this.csrfToken,
      cookieCount: this.cookieStore.size
    });
  }

  /**
   * Clear session state from storage
   */
  async clearSessionState(): Promise<void> {
    if (!this.sessionId || !this.sessionStorage) {
      return;
    }

    try {
      await this.sessionStorage.delete(this.sessionId);
      this.logger.debug("Session state cleared", {
        sessionId: this.sessionId
      });
    } catch (error) {
      this.logger.warn("Failed to clear session state", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  getConfig(): SapConfig {
    return this.config;
  }

  reset(): void {
    if (this.axiosInstance) {
      this.axiosInstance.interceptors.request.clear();
      this.axiosInstance.interceptors.response.clear();
      this.axiosInstance = null;
    }
    this.csrfToken = null;
    this.cookies = null;
    this.cookieStore.clear();
    // Note: baseUrl is not reset as it's derived from immutable config
  }

  async getBaseUrl(): Promise<string> {
    return this.baseUrl;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    if (this.config.client) {
      headers["X-SAP-Client"] = this.config.client;
    }

    const authorization = this.buildAuthorizationHeader();
    if (authorization) {
      headers["Authorization"] = authorization;
    }

    return headers;
  }

  /**
   * Connect to SAP system and initialize session (get CSRF token and cookies)
   * This should be called explicitly before making the first request to ensure
   * proper authentication and session initialization.
   *
   * Concrete implementations must provide auth-specific connection logic:
   * - BaseAbapConnection: Basic auth with CSRF token fetch
   * - JwtAbapConnection: JWT auth with token refresh on 401/403
   */
  abstract connect(): Promise<void>;

  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    const { url: endpoint, method, timeout, data, params, headers: customHeaders } = options;
    const normalizedMethod = method.toUpperCase();
    
    // Build full URL: baseUrl + endpoint
    const requestUrl = `${this.baseUrl}${endpoint}`;

    // Try to ensure CSRF token is available for POST/PUT/DELETE, but don't fail if it can't be fetched
    // The retry logic will handle CSRF token errors automatically
    if (normalizedMethod === "POST" || normalizedMethod === "PUT" || normalizedMethod === "DELETE") {
      if (!this.csrfToken) {
        try {
          await this.ensureFreshCsrfToken(requestUrl);
        } catch (error) {
          // If CSRF token can't be fetched upfront, continue anyway
          // The retry logic will handle CSRF token errors automatically
          this.logger.debug(`[DEBUG] BaseAbapConnection - Could not fetch CSRF token upfront, will retry on error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Start with default Accept header
    const requestHeaders: Record<string, string> = {};
    if (!customHeaders || !customHeaders["Accept"]) {
      requestHeaders["Accept"] = "application/xml, application/json, text/plain, */*";
    }

    // Add custom headers (but they won't override auth/cookies)
    if (customHeaders) {
      Object.assign(requestHeaders, customHeaders);
    }

    // ALWAYS add sap-adt-connection-id header (connectionId is sent for ALL session types)
    if (this.sessionId) {
      requestHeaders["sap-adt-connection-id"] = this.sessionId;
    }

    // Add stateful session headers if stateful mode enabled via enableStatefulSession()
    if (this.sessionMode === "stateful") {
      requestHeaders["x-sap-adt-sessiontype"] = "stateful";
      requestHeaders["sap-adt-request-id"] = randomUUID().replace(/-/g, '');
      requestHeaders["X-sap-adt-profiling"] = "server-time";
    }

    // Add auth headers (these MUST NOT be overridden)
    Object.assign(requestHeaders, await this.getAuthHeaders());

    if ((normalizedMethod === "POST" || normalizedMethod === "PUT" || normalizedMethod === "DELETE") && this.csrfToken) {
      requestHeaders["x-csrf-token"] = this.csrfToken;
    }

    // Add cookies LAST (MUST NOT be overridden by custom headers)
    if (this.cookies) {
      requestHeaders["Cookie"] = this.cookies;
      this.logger.debug(`[DEBUG] BaseAbapConnection - Adding cookies to request (first 100 chars): ${this.cookies.substring(0, 100)}...`);
    } else {
      this.logger.debug(`[DEBUG] BaseAbapConnection - NO COOKIES available for this request to ${requestUrl}`);
    }

    if ((normalizedMethod === "POST" || normalizedMethod === "PUT") && data) {
      if (typeof data === "string" && !requestHeaders["Content-Type"]) {
        if (requestUrl.includes("/usageReferences") && data.includes("usageReferenceRequest")) {
          requestHeaders["Content-Type"] = "application/vnd.sap.adt.repository.usagereferences.request.v1+xml";
          requestHeaders["Accept"] = "application/vnd.sap.adt.repository.usagereferences.result.v1+xml";
        } else {
          requestHeaders["Content-Type"] = "text/plain; charset=utf-8";
        }
      }
    }

    const requestConfig: AxiosRequestConfig = {
      method: normalizedMethod,
      url: requestUrl,
      headers: requestHeaders,
      timeout,
      params
    };

    if (data !== undefined) {
      requestConfig.data = data;
    }

    this.logger.debug(`Executing ${normalizedMethod} request to: ${requestUrl}`, {
      type: "REQUEST_INFO",
      url: requestUrl,
      method: normalizedMethod
    });

    try {
      const response = await this.getAxiosInstance()(requestConfig);
      this.updateCookiesFromResponse(response.headers);

      // Save session state after successful request (if session storage is configured)
      await this.saveSessionState();

      this.logger.debug(`Request succeeded with status ${response.status}`, {
        type: "REQUEST_SUCCESS",
        status: response.status,
        url: requestUrl,
        method: normalizedMethod
      });

      return response;
    } catch (error) {
      const errorDetails: {
        type: string;
        message: string;
        url: string;
        method: string;
        status?: number;
        data?: string;
      } = {
        type: "REQUEST_ERROR",
        message: error instanceof Error ? error.message : String(error),
        url: requestUrl,
        method: normalizedMethod,
        status: error instanceof AxiosError ? error.response?.status : undefined,
        data: undefined
      };

      if (error instanceof AxiosError && error.response) {
        errorDetails.data =
          typeof error.response.data === "string"
            ? error.response.data.slice(0, 200)
            : JSON.stringify(error.response.data).slice(0, 200);

        this.updateCookiesFromResponse(error.response.headers);
      }

      // Save session state even on error (cookies might have been updated)
      await this.saveSessionState();

      // Log 404 as debug (common for existence checks), other errors as error
      if (errorDetails.status === 404) {
        this.logger.debug(errorDetails.message, errorDetails);
      } else {
        this.logger.error(errorDetails.message, errorDetails);
      }

      // Retry logic for CSRF token errors (403 with CSRF message)
      if (this.shouldRetryCsrf(error)) {
        this.logger.debug(
          "CSRF token validation failed, fetching new token and retrying request",
          {
            url: requestUrl,
            method: normalizedMethod
          }
        );

        this.csrfToken = await this.fetchCsrfToken(requestUrl, 5, 2000);
        if (this.csrfToken) {
          requestHeaders["x-csrf-token"] = this.csrfToken;
        }
        if (this.cookies) {
          requestHeaders["Cookie"] = this.cookies;
        }

        const retryResponse = await this.getAxiosInstance()(requestConfig);
        this.updateCookiesFromResponse(retryResponse.headers);

        // Save session state after retry
        await this.saveSessionState();

        return retryResponse;
      }

      // Retry logic for 401 errors on GET requests (authentication issue - need cookies)
      // Only for basic auth - JWT auth will be handled by refresh logic below
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        normalizedMethod === "GET" &&
        this.config.authType === 'basic'  // Only for basic auth
      ) {
        // If we already have cookies from error response, retry immediately
        if (this.cookies) {
          this.logger.debug(`[DEBUG] BaseAbapConnection - 401 on GET request, retrying with cookies from error response`);
          requestHeaders["Cookie"] = this.cookies;

          const retryResponse = await this.getAxiosInstance()(requestConfig);
          this.updateCookiesFromResponse(retryResponse.headers);
          await this.saveSessionState();

          return retryResponse;
        }

        // If no cookies, try to get them via CSRF token fetch
        this.logger.debug(`[DEBUG] BaseAbapConnection - 401 on GET request, attempting to get cookies via CSRF token fetch`);
        try {
          // Try to get CSRF token (this will also get cookies)
          this.csrfToken = await this.fetchCsrfToken(requestUrl, 3, 1000);
          if (this.cookies) {
            requestHeaders["Cookie"] = this.cookies;
            this.logger.debug(`[DEBUG] BaseAbapConnection - Retrying GET request with cookies from CSRF fetch`);

            const retryResponse = await this.getAxiosInstance()(requestConfig);
            this.updateCookiesFromResponse(retryResponse.headers);
            await this.saveSessionState();

            return retryResponse;
          }
        } catch (csrfError) {
          this.logger.debug(`[DEBUG] BaseAbapConnection - Failed to get CSRF token for 401 retry: ${csrfError instanceof Error ? csrfError.message : String(csrfError)}`);
          // Fall through to throw original error
        }
      }

      throw error;
    }
  }

  protected abstract buildAuthorizationHeader(): string;

  /**
   * Fetch CSRF token from SAP system
   * Protected method for use by concrete implementations in their connect() method
   */
  protected async fetchCsrfToken(
    url: string,
    retryCount: number = CSRF_CONFIG.RETRY_COUNT,
    retryDelay: number = CSRF_CONFIG.RETRY_DELAY
  ): Promise<string> {
    let csrfUrl = url;
    // Build CSRF endpoint URL from base URL
    if (!url.includes("/sap/bc/adt/")) {
      // If URL doesn't contain ADT path, append endpoint
      csrfUrl = url.endsWith("/") ? `${url}${CSRF_CONFIG.ENDPOINT.slice(1)}` : `${url}${CSRF_CONFIG.ENDPOINT}`;
    } else if (!url.includes(CSRF_CONFIG.ENDPOINT)) {
      // If URL contains ADT path but not our endpoint, extract base and append endpoint
      const base = url.split("/sap/bc/adt")[0];
      csrfUrl = `${base}${CSRF_CONFIG.ENDPOINT}`;
    }
    // If URL already contains the endpoint, use it as is

    this.logger.debug(`Fetching CSRF token from: ${csrfUrl}`);

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.debug(`Retry attempt ${attempt}/${retryCount} for CSRF token`);
        }

        const authHeaders = await this.getAuthHeaders();
        const headers: Record<string, string> = {
          ...authHeaders,
          ...CSRF_CONFIG.REQUIRED_HEADERS
        };

        // Always add cookies if available - they are needed for session continuity
        // Even on first attempt, if we have cookies from previous session or error response, use them
        if (this.cookies) {
          headers["Cookie"] = this.cookies;
          this.logger.debug(`[DEBUG] BaseAbapConnection - Adding cookies to CSRF token request (attempt ${attempt + 1}, first 100 chars): ${this.cookies.substring(0, 100)}...`);
        } else {
          this.logger.debug(`[DEBUG] BaseAbapConnection - No cookies available for CSRF token request (will get fresh cookies from response)`);
        }

        // Log request details for debugging (only if debug logging is enabled)
        this.logger.debug(`[DEBUG] CSRF Token Request: url=${csrfUrl}, method=GET, hasAuth=${!!authHeaders.Authorization}, hasClient=${!!authHeaders["X-SAP-Client"]}, hasCookies=${!!headers["Cookie"]}, attempt=${attempt + 1}`);

        const response = await this.getAxiosInstance()({
          method: "GET",
          url: csrfUrl,
          headers,
          timeout: getTimeout("csrf")
        });

        this.updateCookiesFromResponse(response.headers);

        const token = response.headers["x-csrf-token"] as string | undefined;
        if (!token) {
          this.logger.error("No CSRF token in response headers", {
            headers: response.headers,
            status: response.status
          });

          if (attempt < retryCount) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            continue;
          }
          throw new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
        }

        if (response.headers["set-cookie"]) {
          this.updateCookiesFromResponse(response.headers);
          if (this.cookies) {
            this.logger.debug(`[DEBUG] BaseAbapConnection - Cookies received from CSRF response (first 100 chars): ${this.cookies.substring(0, 100)}...`);
            this.logger.debug("Cookies extracted from response", {
              cookieLength: this.cookies.length
            });
          }
        }

        // Save session state after CSRF token fetch (cookies and token are now available)
        await this.saveSessionState();

        this.logger.debug("CSRF token successfully obtained");
        return token;
      } catch (error) {
        if (error instanceof AxiosError) {
          // Always try to extract cookies from error response, even on 401
          // This ensures cookies are available for subsequent requests
          if (error.response?.headers) {
            this.updateCookiesFromResponse(error.response.headers);
            if (this.cookies) {
              this.logger.debug("Cookies extracted from error response", {
                status: error.response.status,
                cookieLength: this.cookies.length
              });
            }
          }

          this.logger.error(`CSRF token error: ${error.message}`, {
            url: csrfUrl,
            status: error.response?.status,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1
          });

          if (error.response?.status === 405 && error.response?.headers["x-csrf-token"]) {
            this.logger.debug(
              "CSRF: SAP returned 405 (Method Not Allowed) — not critical, token found in header"
            );

            const token = error.response.headers["x-csrf-token"] as string;
            if (token) {
              this.updateCookiesFromResponse(error.response.headers);
              return token;
            }
          }

          if (error.response?.headers["x-csrf-token"]) {
            this.logger.debug(
              `Got CSRF token despite error (status: ${error.response?.status})`
            );

            const token = error.response.headers["x-csrf-token"] as string;
            this.updateCookiesFromResponse(error.response.headers);
            return token;
          }

          if (error.response) {
            this.logger.error("CSRF error details", {
              status: error.response.status,
              statusText: error.response.statusText,
              headers: Object.keys(error.response.headers),
              data:
                typeof error.response.data === "string"
                  ? error.response.data.slice(0, 200)
                  : JSON.stringify(error.response.data).slice(0, 200)
            });
          } else if (error.request) {
            this.logger.error("CSRF request error - no response received", {
              request: error.request.path
            });
          }
        } else {
          this.logger.error("CSRF non-axios error", {
            error: error instanceof Error ? error.message : String(error)
          });
        }

        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }

        // Preserve original error information, especially AxiosError with response
        if (error instanceof AxiosError && error.response) {
          // Re-throw the original AxiosError to preserve response information
          throw error;
        }

        throw new Error(
          CSRF_ERROR_MESSAGES.FETCH_FAILED(
            retryCount + 1,
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    }

    throw new Error("CSRF token fetch failed unexpectedly");
  }

  /**
   * Get CSRF token (protected for use by subclasses)
   */
  protected getCsrfToken(): string | null {
    return this.csrfToken;
  }

  /**
   * Set CSRF token (protected for use by subclasses)
   */
  protected setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  /**
   * Get cookies (protected for use by subclasses)
   */
  protected getCookies(): string | null {
    return this.cookies;
  }

  private updateCookiesFromResponse(headers?: Record<string, any>): void {
    if (!headers) {
      return;
    }

    const setCookie = headers["set-cookie"] as string[] | string | undefined;
    if (!setCookie) {
      return;
    }

    const cookiesArray = Array.isArray(setCookie) ? setCookie : [setCookie];

    for (const entry of cookiesArray) {
      if (typeof entry !== "string") {
        continue;
      }

      const [nameValue] = entry.split(";");
      if (!nameValue) {
        continue;
      }

      const [name, ...rest] = nameValue.split("=");
      if (!name) {
        continue;
      }

      const trimmedName = name.trim();
      const trimmedValue = rest.join("=").trim();

      if (!trimmedName) {
        continue;
      }

      this.cookieStore.set(trimmedName, trimmedValue);
    }

    if (this.cookieStore.size === 0) {
      return;
    }

    const combined = Array.from(this.cookieStore.entries())
      .map(([name, value]) => (value ? `${name}=${value}` : name))
      .join("; ");

    if (!combined) {
      return;
    }

    this.cookies = combined;
    this.logger.debug(
      `[DEBUG] BaseAbapConnection - Updated cookies from response (first 100 chars): ${this.cookies.substring(0, 100)}...`
    );
  }

  private getAxiosInstance(): AxiosInstance {
    if (!this.axiosInstance) {
      const rejectUnauthorized =
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === "1" ||
        (process.env.TLS_REJECT_UNAUTHORIZED === "1" &&
          process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0");

      this.logger.debug(`TLS configuration: rejectUnauthorized=${rejectUnauthorized}`);

      this.axiosInstance = axios.create({
        httpsAgent: new Agent({
          rejectUnauthorized
        })
      });
    }

    return this.axiosInstance;
  }

  private async ensureFreshCsrfToken(requestUrl: string): Promise<void> {
    // If we already have a CSRF token, reuse it to keep the same SAP session
    // SAP ties the lock handle to the HTTP session (SAP_SESSIONID cookie)
    if (this.csrfToken) {
      this.logger.debug(`[DEBUG] BaseAbapConnection - Reusing existing CSRF token to maintain session`);
      return;
    }

    try {
      this.logger.debug(`[DEBUG] BaseAbapConnection - Fetching NEW CSRF token (will create new SAP session)`);
      this.csrfToken = await this.fetchCsrfToken(requestUrl);
    } catch (error) {
      // fetchCsrfToken already handles auth errors and auto-refresh
      // Just re-throw the error with minimal logging to avoid duplicate error messages
      const errorMsg = error instanceof Error ? error.message : CSRF_ERROR_MESSAGES.REQUIRED_FOR_MUTATION;

      // Only log at DEBUG level to avoid duplicate error messages
      // (fetchCsrfToken already logged the error at ERROR level if auth failed)
      this.logger.debug(`[DEBUG] BaseAbapConnection - ensureFreshCsrfToken failed: ${errorMsg}`);

      throw error;
    }
  }

  private shouldRetryCsrf(error: unknown): boolean {
    if (!(error instanceof AxiosError)) {
      return false;
    }

    const responseData = error.response?.data;
    const responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData || "");

    // Don't retry for JWT auth - refresh logic will handle it
    if (this.config.authType === 'jwt') {
      return false;
    }

    // Retry on 403 with CSRF message, or if response mentions CSRF token
    // Also retry on 401 for POST/PUT/DELETE if we don't have CSRF token yet (might need to get cookies first)
    const method = error.config?.method?.toUpperCase();
    const isPostPutDelete = method && ["POST", "PUT", "DELETE"].includes(method);
    const needsCsrfToken = !!isPostPutDelete && !this.csrfToken;

    return (
      (!!error.response && error.response.status === 403 && responseText.includes("CSRF")) ||
      responseText.includes("CSRF token") ||
      (needsCsrfToken && error.response?.status === 401)
    );
  }
}

// Export only for internal use by BaseAbapConnection and JwtAbapConnection
export { AbstractAbapConnection };
