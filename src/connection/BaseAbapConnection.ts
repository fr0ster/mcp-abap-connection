import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { Agent } from "https";
import { ILogger, ISessionStorage, SessionState } from "../logger.js";
import { getTimeout } from "../utils/timeouts.js";
import { SapConfig } from "../config/sapConfig.js";
import { AbapConnection, AbapRequestOptions } from "./AbapConnection.js";

export abstract class BaseAbapConnection implements AbapConnection {
  private axiosInstance: AxiosInstance | null = null;
  private csrfToken: string | null = null;
  private cookies: string | null = null;
  private cookieStore: Map<string, string> = new Map();
  private cachedBaseUrl: string | null = null;
  private sessionId: string | null = null;
  private sessionStorage: ISessionStorage | null = null;
  private sessionMode: "stateless" | "stateful" = "stateless";

  protected constructor(
    private readonly config: SapConfig,
    private readonly logger: ILogger,
    sessionStorage?: ISessionStorage,
    sessionId?: string
  ) {
    this.sessionStorage = sessionStorage || null;
    this.sessionId = sessionId || null;
    this.sessionMode = sessionId && sessionStorage ? "stateful" : "stateless";
  }

  /**
   * Enable stateful session mode with storage
   * @param sessionId - Unique session identifier
   * @param storage - Storage implementation for persisting session state
   */
  async enableStatefulSession(sessionId: string, storage: ISessionStorage): Promise<void> {
    this.sessionId = sessionId;
    this.sessionStorage = storage;
    this.sessionMode = "stateful";

    // Try to load existing session state
    await this.loadSessionState();

    this.logger.info("Stateful session enabled", {
      sessionId,
      hasExistingState: !!this.csrfToken || !!this.cookies
    });
  }

  /**
   * Disable stateful session mode (switch to stateless)
   * Optionally saves current state before switching
   */
  async disableStatefulSession(saveBeforeDisable: boolean = false): Promise<void> {
    if (this.sessionMode === "stateless") {
      return;
    }

    if (saveBeforeDisable && this.sessionId && this.sessionStorage) {
      await this.saveSessionState();
    }

    this.sessionMode = "stateless";
    this.sessionId = null;
    this.sessionStorage = null;

    this.logger.info("Stateful session disabled", {
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
   */
  setSessionStorage(storage: ISessionStorage | null): void {
    this.sessionStorage = storage;
    if (storage && this.sessionId) {
      this.sessionMode = "stateful";
    } else if (!storage) {
      this.sessionMode = "stateless";
    }
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
    this.cachedBaseUrl = null;
  }

  async getBaseUrl(): Promise<string> {
    if (this.cachedBaseUrl) {
      return this.cachedBaseUrl;
    }

    const { url } = this.config;
    try {
      const urlObj = new URL(url);
      this.cachedBaseUrl = urlObj.origin;
      return this.cachedBaseUrl;
    } catch (error) {
      const errorMessage = `Invalid URL in configuration: ${
        error instanceof Error ? error.message : error
      }`;
      throw new Error(errorMessage);
    }
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
   * If connection fails, it logs a warning but doesn't throw an error.
   * The retry logic in makeAdtRequest will handle CSRF token errors automatically.
   */
  async connect(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger.debug(`[DEBUG] BaseAbapConnection - Connecting to SAP system: ${discoveryUrl}`);

    try {
      // Try to get CSRF token (this will also get cookies)
      this.csrfToken = await this.fetchCsrfToken(discoveryUrl, 3, 1000);

      // Save session state after successful connection
      await this.saveSessionState();

      this.logger.info("Successfully connected to SAP system", {
        hasCsrfToken: !!this.csrfToken,
        hasCookies: !!this.cookies,
        cookieLength: this.cookies?.length || 0
      });
    } catch (error) {
      // Don't throw error - just log warning
      // The retry logic in makeAdtRequest will handle CSRF token errors automatically
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[WARN] BaseAbapConnection - Could not connect to SAP system upfront: ${errorMsg}. Will retry on first request.`);

      // Still try to extract cookies from error response if available
      if (error instanceof AxiosError && error.response?.headers) {
        this.updateCookiesFromResponse(error.response.headers);
        if (this.cookies) {
          this.logger.debug(`[DEBUG] BaseAbapConnection - Cookies extracted from error response during connect (first 100 chars): ${this.cookies.substring(0, 100)}...`);
          await this.saveSessionState();
        }
      }
    }
  }

  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    const { url, method, timeout, data, params, headers: customHeaders } = options;
    const normalizedMethod = method.toUpperCase();
    const requestUrl = this.normalizeRequestUrl(url);

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

    this.logger.info(`Executing ${normalizedMethod} request to: ${requestUrl}`, {
      type: "REQUEST_INFO",
      url: requestUrl,
      method: normalizedMethod
    });

    try {
      const response = await this.getAxiosInstance()(requestConfig);
      this.updateCookiesFromResponse(response.headers);

      // Save session state after successful request (if session storage is configured)
      await this.saveSessionState();

      this.logger.info(`Request succeeded with status ${response.status}`, {
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

      this.logger.error(errorDetails.message, errorDetails);

      // Retry logic for CSRF token errors (403 with CSRF message)
      if (this.shouldRetryCsrf(error)) {
        if (this.logger.csrfToken) {
          this.logger.csrfToken(
            "retry",
            "CSRF token validation failed, fetching new token and retrying request",
            {
              url: requestUrl,
              method: normalizedMethod
            }
          );
        }

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
      // Don't retry if JWT expired - it won't help
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        normalizedMethod === "GET" &&
        !this.isJwtExpiredError(error)
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

      // If JWT expired, throw a more specific error
      if (error instanceof AxiosError && error.response?.status === 401 && this.isJwtExpiredError(error)) {
        throw new Error("JWT token has expired. Please refresh your authentication token.");
      }

      throw error;
    }
  }

  protected abstract buildAuthorizationHeader(): string;

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

      if (this.logger.tlsConfig) {
        this.logger.tlsConfig(rejectUnauthorized);
      }

      this.axiosInstance = axios.create({
        httpsAgent: new Agent({
          rejectUnauthorized
        })
      });
    }

    return this.axiosInstance;
  }

  private normalizeRequestUrl(url: string): string {
    if (!url.includes("/sap/bc/adt/") && !url.endsWith("/sap/bc/adt")) {
      return url.endsWith("/") ? `${url}sap/bc/adt` : `${url}/sap/bc/adt`;
    }
    return url;
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
      const errorMsg =
        "CSRF token is required for POST/PUT requests but could not be fetched";

      // Log detailed error information
      const errorDetails = error instanceof Error ? error.message : String(error);
      const axiosError = error as any;
      const authHeaders = await this.getAuthHeaders();

      // Check if this is a JWT expiration issue (401 with auth-related response)
      const isJwtExpired = this.isJwtExpiredError(axiosError);

      const errorContext: {
        type: string;
        cause: string;
        status?: number;
        statusText?: string;
        hasCookies: boolean;
        hasAuthHeaders: boolean;
        isJwtExpired: boolean;
        responseData?: string;
      } = {
        type: "CSRF_FETCH_ERROR",
        cause: errorDetails,
        status: axiosError?.response?.status,
        statusText: axiosError?.response?.statusText,
        hasCookies: !!this.cookies,
        hasAuthHeaders: !!authHeaders.Authorization,
        isJwtExpired: isJwtExpired
      };

      if (axiosError?.response?.data) {
        errorContext.responseData = typeof axiosError.response.data === 'string'
          ? axiosError.response.data.substring(0, 200)
          : JSON.stringify(axiosError.response.data).substring(0, 200);
      }

      this.logger.error(errorMsg, errorContext);

      // If JWT expired, throw a more specific error
      if (isJwtExpired) {
        throw new Error("JWT token has expired. Please refresh your authentication token.");
      }

      // If we have cookies from error response, log it
      if (this.cookies) {
        this.logger.debug(`[DEBUG] BaseAbapConnection - Cookies available after CSRF fetch error: ${this.cookies.substring(0, 100)}...`);
      }

      throw new Error(errorMsg);
    }
  }

  private async fetchCsrfToken(url: string, retryCount = 3, retryDelay = 1000): Promise<string> {
    let csrfUrl = url;
    if (!url.includes("/sap/bc/adt/")) {
      csrfUrl = url.endsWith("/") ? `${url}sap/bc/adt/discovery` : `${url}/sap/bc/adt/discovery`;
    } else if (!url.includes("/sap/bc/adt/discovery")) {
      const base = url.split("/sap/bc/adt")[0];
      csrfUrl = `${base}/sap/bc/adt/discovery`;
    }

    if (this.logger.csrfToken) {
      this.logger.csrfToken("fetch", `Fetching CSRF token from: ${csrfUrl}`);
    }

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        if (attempt > 0 && this.logger.csrfToken) {
          this.logger.csrfToken("retry", `Retry attempt ${attempt}/${retryCount} for CSRF token`);
        }

        const authHeaders = await this.getAuthHeaders();
        const headers: Record<string, string> = {
          ...authHeaders,
          "x-csrf-token": "fetch",
          Accept: "application/atomsvc+xml"
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
          if (this.logger.csrfToken) {
            this.logger.csrfToken("error", "No CSRF token in response headers", {
              headers: response.headers,
              status: response.status
            });
          }

          if (attempt < retryCount) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            continue;
          }
          throw new Error("No CSRF token in response headers");
        }

        if (response.headers["set-cookie"]) {
          this.updateCookiesFromResponse(response.headers);
          if (this.cookies) {
            this.logger.debug(`[DEBUG] BaseAbapConnection - Cookies received from CSRF response (first 100 chars): ${this.cookies.substring(0, 100)}...`);
            if (this.logger.csrfToken) {
              this.logger.csrfToken("success", "Cookies extracted from response", {
                cookieLength: this.cookies.length
              });
            }
          }
        }

        // Save session state after CSRF token fetch (cookies and token are now available)
        await this.saveSessionState();

        if (this.logger.csrfToken) {
          this.logger.csrfToken("success", "CSRF token successfully obtained");
        }
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

          if (this.logger.csrfToken) {
            this.logger.csrfToken("error", `CSRF token error: ${error.message}`, {
              url: csrfUrl,
              status: error.response?.status,
              attempt: attempt + 1,
              maxAttempts: retryCount + 1
            });
          }

          if (error.response?.status === 405 && error.response?.headers["x-csrf-token"]) {
            if (this.logger.csrfToken) {
              this.logger.csrfToken(
                "retry",
                "CSRF: SAP returned 405 (Method Not Allowed) — not critical, token found in header"
              );
            }

            const token = error.response.headers["x-csrf-token"] as string;
            if (token) {
              this.updateCookiesFromResponse(error.response.headers);
              return token;
            }
          }

          if (error.response?.headers["x-csrf-token"]) {
            if (this.logger.csrfToken) {
              this.logger.csrfToken(
                "success",
                `Got CSRF token despite error (status: ${error.response?.status})`
              );
            }

            const token = error.response.headers["x-csrf-token"] as string;
            this.updateCookiesFromResponse(error.response.headers);
            return token;
          }

          if (error.response && this.logger.csrfToken) {
            this.logger.csrfToken("error", "CSRF error details", {
              status: error.response.status,
              statusText: error.response.statusText,
              headers: Object.keys(error.response.headers),
              data:
                typeof error.response.data === "string"
                  ? error.response.data.slice(0, 200)
                  : JSON.stringify(error.response.data).slice(0, 200)
            });
          } else if (error.request && this.logger.csrfToken) {
            this.logger.csrfToken("error", "CSRF request error - no response received", {
              request: error.request.path
            });
          }
        } else if (this.logger.csrfToken) {
          this.logger.csrfToken("error", "CSRF non-axios error", {
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
          `Failed to fetch CSRF token after ${retryCount + 1} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    throw new Error("CSRF token fetch failed unexpectedly");
  }

  /**
   * Check if 401 error is due to expired JWT token
   * Distinguishes between JWT expiration (auth failure) and cookie issues (session failure)
   */
  private isJwtExpiredError(error: any): boolean {
    if (!error?.response || error.response.status !== 401) {
      return false;
    }

    const responseData = error.response.data;
    if (!responseData) {
      return false;
    }

    const responseText = typeof responseData === "string"
      ? responseData.toLowerCase()
      : JSON.stringify(responseData).toLowerCase();

    // Check for JWT/token expiration indicators
    // SAP typically returns HTML with "Anmeldung fehlgeschlagen" (Login failed) for expired tokens
    // or JSON with "unauthorized" / "invalid_token" / "expired" messages
    const jwtExpirationIndicators = [
      "anmeldung fehlgeschlagen",  // German: Login failed
      "unauthorized",
      "invalid_token",
      "token expired",
      "expired",
      "authentication failed",
      "401 nicht autorisiert"  // German: 401 Unauthorized
    ];

    // If we have cookies but still get 401, it's likely JWT expiration
    // If we don't have cookies, it could be either JWT or cookie issue
    const hasCookies = !!this.cookies;

    // If response contains JWT expiration indicators, it's definitely JWT expiration
    if (jwtExpirationIndicators.some(indicator => responseText.includes(indicator))) {
      return true;
    }

    // If we have cookies and get 401, it's more likely JWT expiration than cookie issue
    // (cookies would typically result in different error or work)
    if (hasCookies && this.config.authType === "jwt") {
      return true;
    }

    return false;
  }

  private shouldRetryCsrf(error: unknown): boolean {
    if (!(error instanceof AxiosError)) {
      return false;
    }

    const responseData = error.response?.data;
    const responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData || "");

    // Don't retry if JWT expired - it won't help
    if (this.isJwtExpiredError(error)) {
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
      (needsCsrfToken && error.response?.status === 401 && !this.isJwtExpiredError(error))
    );
  }
}

