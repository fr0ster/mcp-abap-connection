#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { program } = require("commander");
const express = require("express");
const open = require("open").default;
const http = require("http");

/**
 * Get .env file path
 * @param {string} customPath Optional custom path
 * @returns {string} Path to .env file
 */
function getEnvFilePath(customPath) {
  if (customPath) {
    return path.resolve(process.cwd(), customPath);
  }
  return path.resolve(process.cwd(), ".env");
}

// Browser selection via --browser option (chrome, edge, firefox, system, none)
const BROWSER_MAP = {
  chrome: "chrome",
  edge: "msedge",
  firefox: "firefox",
  system: undefined, // system default
  none: null, // no browser, manual URL copy
};

/**
 * Reads a JSON service key file
 * @param {string} filePath Path to the service key file
 * @returns {object} Service key data object
 */
function readServiceKey(filePath) {
  try {
    const fullPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) {
      console.error(`File not found: ${fullPath}`);
      process.exit(1);
    }

    const fileContent = fs.readFileSync(fullPath, "utf8");
    return JSON.parse(fileContent);
  } catch (error) {
    console.error(`Error reading service key: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Reads existing .env file and parses it
 * @param {string} envFilePath Path to .env file
 * @returns {Object} Parsed .env values
 */
function readEnvFile(envFilePath) {
  try {
    if (!fs.existsSync(envFilePath)) {
      return {};
    }
    const content = fs.readFileSync(envFilePath, "utf8");
    const env = {};
    content.split("\n").forEach((line) => {
      line = line.trim();
      if (line && !line.startsWith("#")) {
        const [key, ...valueParts] = line.split("=");
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join("=").trim();
        }
      }
    });
    return env;
  } catch (error) {
    console.error(`Error reading .env file: ${error.message}`);
    return {};
  }
}

/**
 * Attempts to refresh JWT token using refresh token
 * @param {string} refreshToken Refresh token from .env
 * @param {string} uaaUrl UAA URL from .env
 * @param {string} clientId UAA client ID from .env
 * @param {string} clientSecret UAA client secret from .env
 * @returns {Promise<{accessToken: string, refreshToken: string}|null>} New tokens or null if failed
 */
async function tryRefreshToken(refreshToken, uaaUrl, clientId, clientSecret) {
  try {
    console.log("🔄 Attempting to refresh existing JWT token...");
    const tokenUrl = `${uaaUrl}/oauth/token`;

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);

    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const response = await axios({
      method: "post",
      url: tokenUrl,
      headers: {
        Authorization: `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: params.toString(),
      timeout: 10000, // 10 second timeout
    });

    if (response.data && response.data.access_token) {
      console.log("✅ Token refreshed successfully!");
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || refreshToken,
      };
    }
    return null;
  } catch (error) {
    console.log(`⚠️  Token refresh failed: ${error.message}`);
    console.log("📝 Falling back to browser authentication...");
    return null;
  }
}

/**
 * Decodes JWT token and extracts expiration time
 * @param {string} token JWT token string
 * @returns {Object|null} Object with expiration date and timestamp, or null if decoding fails
 */
function getTokenExpiry(token) {
  try {
    if (!token) return null;
    
    // JWT format: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    // Decode payload (base64url)
    const payload = parts[1];
    // Add padding if needed
    const paddedPayload = payload + '='.repeat((4 - payload.length % 4) % 4);
    const decodedPayload = Buffer.from(paddedPayload, 'base64').toString('utf8');
    const payloadObj = JSON.parse(decodedPayload);
    
    if (!payloadObj.exp) return null;
    
    // exp is Unix timestamp in seconds
    const expiryTimestamp = payloadObj.exp * 1000; // Convert to milliseconds
    const expiryDate = new Date(expiryTimestamp);
    
    return {
      timestamp: expiryTimestamp,
      date: expiryDate,
      dateString: expiryDate.toISOString(),
      readableDate: expiryDate.toLocaleString('en-US', { 
        timeZone: 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    };
  } catch (error) {
    // Silently fail - token might not be a valid JWT or might be in different format
    return null;
  }
}

/**
 * Updates the .env file with new values
 * @param {Object} updates Object with updated values
 * @param {string} envFilePath Path to .env file
 */
function updateEnvFile(updates, envFilePath) {
  try {
    // Always remove the old .env file if it exists
    if (fs.existsSync(envFilePath)) {
      fs.unlinkSync(envFilePath);
    }
    let lines = [];
    
    // Get token expiry information
    const jwtTokenExpiry = getTokenExpiry(updates.SAP_JWT_TOKEN);
    const refreshTokenExpiry = getTokenExpiry(updates.SAP_REFRESH_TOKEN);
    
    // Add token expiry comments at the beginning if JWT auth
    if (updates.SAP_AUTH_TYPE === "jwt") {
      lines.push("# Token Expiry Information (auto-generated)");
      if (jwtTokenExpiry) {
        lines.push(`# JWT Token expires: ${jwtTokenExpiry.readableDate} (UTC)`);
        lines.push(`# JWT Token expires at: ${jwtTokenExpiry.dateString}`);
      } else {
        lines.push("# JWT Token expiry: Unable to determine (token may not be a standard JWT)");
      }
      if (refreshTokenExpiry) {
        lines.push(`# Refresh Token expires: ${refreshTokenExpiry.readableDate} (UTC)`);
        lines.push(`# Refresh Token expires at: ${refreshTokenExpiry.dateString}`);
      } else if (updates.SAP_REFRESH_TOKEN) {
        lines.push("# Refresh Token expiry: Unable to determine (token may not be a standard JWT)");
      }
      lines.push("");
    }
    
    if (updates.SAP_AUTH_TYPE === "jwt") {
      // jwt: write only relevant params
      const jwtAllowed = [
        "SAP_URL",
        "SAP_CLIENT",
        "SAP_LANGUAGE",
        "TLS_REJECT_UNAUTHORIZED",
        "SAP_AUTH_TYPE",
        "SAP_JWT_TOKEN",
        "SAP_REFRESH_TOKEN",
        "SAP_UAA_URL",
        "SAP_UAA_CLIENT_ID",
        "SAP_UAA_CLIENT_SECRET",
      ];
      jwtAllowed.forEach((key) => {
        if (updates[key]) lines.push(`${key}=${updates[key]}`);
      });
      lines.push("");
      lines.push("# For JWT authentication");
      lines.push("# SAP_USERNAME=your_username");
      lines.push("# SAP_PASSWORD=your_password");
    } else {
      // basic: write only relevant params
      const basicAllowed = [
        "SAP_URL",
        "SAP_CLIENT",
        "SAP_LANGUAGE",
        "TLS_REJECT_UNAUTHORIZED",
        "SAP_AUTH_TYPE",
        "SAP_USERNAME",
        "SAP_PASSWORD",
      ];
      basicAllowed.forEach((key) => {
        if (updates[key]) lines.push(`${key}=${updates[key]}`);
      });
      lines.push("");
      lines.push("# For JWT authentication (not used for basic)");
      lines.push("# SAP_JWT_TOKEN=your_jwt_token_here");
    }
    fs.writeFileSync(envFilePath, lines.join("\n") + "\n", "utf8");
    console.log(".env file created successfully.");
  } catch (error) {
    console.error(`Error updating .env file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Builds the JWT (OAuth2) authentication URL
 * @param {Object} serviceKey SAP BTP service key object
 * @param {number} port Redirect URL port
 * @returns {string} Authentication URL
 */
function getJwtAuthorizationUrl(serviceKey, port = 3001) {
  // Use serviceKey.uaa.url (OAuth endpoint) for OAuth2 authorization URL (correct for BTP ABAP)
  const oauthUrl = serviceKey.uaa?.url;
  const clientid = serviceKey.uaa?.clientid;
  const redirectUri = `http://localhost:${port}/callback`;
  return `${oauthUrl}/oauth/authorize?client_id=${encodeURIComponent(
    clientid
  )}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/**
 * Starts a local server to intercept the authentication response
 * @param {Object} serviceKey SAP BTP service key object
 * @param {string} browser Browser to open
 * @param {string} flow Flow type: jwt (OAuth2)
 * @returns {Promise<{accessToken: string, refreshToken?: string}>} Promise that resolves to tokens
 */
async function startAuthServer(serviceKey, browser = undefined, flow = "jwt") {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = http.createServer(app);
    const PORT = 3001;
    let serverInstance = null;

    // Choose the authorization URL
    const authorizationUrl = getJwtAuthorizationUrl(serviceKey, PORT);

    // JWT OAuth2 flow (get code, exchange for token)
    app.get("/callback", async (req, res) => {
      try {
        const { code } = req.query;
        if (!code) {
          res.status(400).send("Error: Authorization code missing");
          return reject(new Error("Authorization code missing"));
        }
        console.log("Authorization code received");
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SAP BTP Authentication</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            text-align: center;
            margin: 0;
            padding: 50px 20px;
            background: linear-gradient(135deg, #0070f3 0%, #00d4ff 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }
        .container {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 40px;
            backdrop-filter: blur(10px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            max-width: 500px;
            width: 100%;
        }
        .success-icon {
            font-size: 4rem;
            margin-bottom: 20px;
            color: #4ade80;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }
        h1 {
            margin: 0 0 20px 0;
            font-size: 2rem;
            font-weight: 300;
        }
        p {
            margin: 0;
            font-size: 1.1rem;
            opacity: 0.9;
            line-height: 1.5;
        }
        .sap-logo {
            margin-top: 30px;
            font-weight: bold;
            opacity: 0.7;
            font-size: 0.9rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✓</div>
        <h1>Authentication Successful!</h1>
        <p>You have successfully authenticated with SAP BTP.</p>
        <p>You can now close this browser window.</p>
        <div class="sap-logo">SAP Business Technology Platform</div>
    </div>
</body>
</html>`);
        try {
          const tokens = await exchangeCodeForToken(serviceKey, code);
          server.close(() => {
            console.log("Authentication server stopped");
          });
          resolve(tokens);
        } catch (error) {
          reject(error);
        }
      } catch (error) {
        console.error("Error handling callback:", error);
        res.status(500).send("Error processing authentication");
        reject(error);
      }
    });

    serverInstance = server.listen(PORT, () => {
      console.log(`Authentication server started on port ${PORT}`);

      const browserApp = BROWSER_MAP[browser];
      if (!browser || browser === "none" || browserApp === null) {
        console.log(
          "\nBrowser not specified. Please manually open the following URL:"
        );
        console.log("");
        console.log(`🔗 ${authorizationUrl}`);
        console.log("");
        console.log(
          "Copy and paste this URL into your browser to authenticate.\n"
        );
      } else {
        console.log("Opening browser for authentication...");
        if (browserApp) {
          open(authorizationUrl, { app: { name: browserApp } });
        } else {
          open(authorizationUrl);
        }
      }
    });

    setTimeout(() => {
      if (serverInstance) {
        serverInstance.close();
        reject(new Error("Authentication timeout. Process aborted."));
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Exchanges the authorization code for tokens
 * @param {Object} serviceKey SAP BTP service key object
 * @param {string} code Authorization code
 * @returns {Promise<{accessToken: string, refreshToken?: string}>} Promise that resolves to tokens
 */
async function exchangeCodeForToken(serviceKey, code) {
  try {
    const { url, clientid, clientsecret } = serviceKey.uaa;
    const tokenUrl = `${url}/oauth/token`;
    const redirectUri = "http://localhost:3001/callback";

    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", redirectUri);

    const authString = Buffer.from(`${clientid}:${clientsecret}`).toString(
      "base64"
    );

    const response = await axios({
      method: "post",
      url: tokenUrl,
      headers: {
        Authorization: `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: params.toString(),
    });

    if (response.data && response.data.access_token) {
      console.log("OAuth token received successfully.");
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token
      };
    } else {
      throw new Error("Response does not contain access_token");
    }
  } catch (error) {
    if (error.response) {
      console.error(
        `API error (${error.response.status}): ${JSON.stringify(
          error.response.data
        )}`
      );
    } else {
      console.error(`Error obtaining OAuth token: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Refreshes the access token using refresh token
 * @param {Object} serviceKey SAP BTP service key object
 * @param {string} refreshToken Refresh token
 * @returns {Promise<{accessToken: string, refreshToken?: string}>} Promise that resolves to new tokens
 */
async function refreshJwtToken(serviceKey, refreshToken) {
  try {
    const { url, clientid, clientsecret } = serviceKey.uaa;
    const tokenUrl = `${url}/oauth/token`;

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);

    const authString = Buffer.from(`${clientid}:${clientsecret}`).toString(
      "base64"
    );

    const response = await axios({
      method: "post",
      url: tokenUrl,
      headers: {
        Authorization: `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: params.toString(),
    });

    if (response.data && response.data.access_token) {
      console.log("Access token refreshed successfully.");
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || refreshToken // Use new refresh token if provided, otherwise keep old one
      };
    } else {
      throw new Error("Response does not contain access_token");
    }
  } catch (error) {
    if (error.response) {
      console.error(
        `API error (${error.response.status}): ${JSON.stringify(
          error.response.data
        )}`
      );
    } else {
      console.error(`Error refreshing OAuth token: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Main program function
 */
async function main() {
  program
    .name("sap-abap-auth")
    .description(
      "CLI utility for authentication in SAP BTP ABAP Environment (Steampunk) via browser. Creates .env file with connection configuration."
    )
    .version("0.1.0")
    .helpOption("-h, --help", "Show help for all commands and options");

  program
    .command("auth")
    .description(
      "Authenticate in SAP BTP ABAP Environment (Steampunk) via browser and update .env file (JWT)"
    )
    .requiredOption(
      "-k, --key <path>",
      "Path to the service key file in JSON format"
    )
    .option(
      "-b, --browser <browser>",
      "Browser to open (chrome, edge, firefox, system, none). Use 'none' or omit to display URL for manual copy."
    )
    .option(
      "-o, --output <path>",
      "Path to output .env file (default: .env in current directory)"
    )
    .option(
      "-f, --force",
      "Force browser authentication even if valid tokens exist in .env"
    )
    .helpOption("-h, --help", "Show help for the auth command")
    .action(async (options) => {
      try {
        if (!options.key) {
          console.error(
            "Service key file (--key) is required for authentication. Please provide a valid service key JSON file."
          );
          process.exit(1);
        }
        console.log("Starting authentication process...");
        const serviceKey = readServiceKey(options.key);
        console.log("Service key read successfully.");

        // Validate required fields in service key
        const abapUrl =
          serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url;
        if (!abapUrl) {
          console.error(
            "SAP_URL is missing in the service key. Please check your service key JSON file."
          );
          process.exit(1);
        }

        let tokens = null;

        // Try to refresh existing token if not forced
        if (!options.force) {
          const envFilePath = getEnvFilePath(options.output);
          const existingEnv = readEnvFile(envFilePath);

          // Check if we have all necessary data for token refresh
          if (
            existingEnv.SAP_REFRESH_TOKEN &&
            existingEnv.SAP_UAA_URL &&
            existingEnv.SAP_UAA_CLIENT_ID &&
            existingEnv.SAP_UAA_CLIENT_SECRET
          ) {
            tokens = await tryRefreshToken(
              existingEnv.SAP_REFRESH_TOKEN,
              existingEnv.SAP_UAA_URL,
              existingEnv.SAP_UAA_CLIENT_ID,
              existingEnv.SAP_UAA_CLIENT_SECRET
            );
          } else if (existingEnv.SAP_REFRESH_TOKEN) {
            console.log("⚠️  Refresh token found in .env but missing UAA credentials");
            console.log("📝 Falling back to browser authentication...");
          }
        } else {
          console.log("🔒 Force mode enabled - skipping token refresh");
        }

        // Fallback to browser authentication if refresh failed or was skipped
        if (!tokens) {
          console.log("🌐 Starting browser authentication...");
          tokens = await startAuthServer(serviceKey, options.browser, "jwt");
          if (!tokens || !tokens.accessToken) {
            console.error("JWT token was not obtained. Authentication failed.");
            process.exit(1);
          }
        }

        // Collect all relevant parameters from service key
        const envUpdates = {
          SAP_URL: abapUrl,
          TLS_REJECT_UNAUTHORIZED: "0",
          SAP_AUTH_TYPE: "jwt",
          SAP_JWT_TOKEN: tokens.accessToken,
        };

        // Add refresh token if available
        if (tokens.refreshToken) {
          envUpdates.SAP_REFRESH_TOKEN = tokens.refreshToken;
        }

        // Add UAA credentials for token refresh
        if (serviceKey.uaa?.url) {
          envUpdates.SAP_UAA_URL = serviceKey.uaa.url;
        }
        if (serviceKey.uaa?.clientid) {
          envUpdates.SAP_UAA_CLIENT_ID = serviceKey.uaa.clientid;
        }
        if (serviceKey.uaa?.clientsecret) {
          envUpdates.SAP_UAA_CLIENT_SECRET = serviceKey.uaa.clientsecret;
        }
        // Optional: client
        const abapClient =
          serviceKey.client || serviceKey.abap?.client || serviceKey.sap_client;
        if (abapClient) {
          envUpdates.SAP_CLIENT = abapClient;
        }
        // Optional: language
        if (serviceKey.language) {
          envUpdates.SAP_LANGUAGE = serviceKey.language;
        } else if (serviceKey.abap && serviceKey.abap.language) {
          envUpdates.SAP_LANGUAGE = serviceKey.abap.language;
        }

        // Use custom output path if provided
        const envFilePath = getEnvFilePath(options.output);
        updateEnvFile(envUpdates, envFilePath);
        console.log("Authentication completed successfully!");
        process.exit(0);
      } catch (error) {
        console.error(`Error during authentication: ${error.message}`);
        process.exit(1);
      }
    });

  // Parse and handle command-line arguments
  program.parse(process.argv);

  // If no arguments were provided, show help
  if (process.argv.length === 2) {
    program.help();
  }
}

// Execute the main function
main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});

