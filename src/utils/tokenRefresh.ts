/**
 * Token refresh utilities for JWT authentication
 */

import axios from 'axios';

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Refreshes the access token using refresh token
 * @param refreshToken Refresh token
 * @param uaaUrl UAA URL (e.g., https://your-account.authentication.eu10.hana.ondemand.com)
 * @param clientId UAA client ID
 * @param clientSecret UAA client secret
 * @returns Promise that resolves to new tokens
 */
export async function refreshJwtToken(
  refreshToken: string,
  uaaUrl: string,
  clientId: string,
  clientSecret: string
): Promise<TokenRefreshResult> {
  try {
    const tokenUrl = `${uaaUrl}/oauth/token`;

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);

    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await axios({
      method: 'post',
      url: tokenUrl,
      headers: {
        Authorization: `Basic ${authString}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: params.toString(),
    });

    if (response.data && response.data.access_token) {
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || refreshToken, // Use new refresh token if provided, otherwise keep old one
      };
    } else {
      throw new Error('Response does not contain access_token');
    }
  } catch (error: any) {
    if (error.response) {
      throw new Error(
        `Token refresh failed (${error.response.status}): ${JSON.stringify(error.response.data)}`
      );
    } else {
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }
}

