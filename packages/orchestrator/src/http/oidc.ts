import * as client from 'openid-client';
import type { OidcClient, User } from './public.js';

export interface EntraOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * C-8 Entra ID sign-in (auth code + PKCE). Group restriction is enforced by "assignment required" on the
 * enterprise app, so Entra refuses tokens for users outside the assigned group.
 */
export async function createEntraClient(opts: EntraOptions): Promise<OidcClient> {
  const config = await client.discovery(new URL(opts.issuer), opts.clientId, opts.clientSecret);
  return {
    authorizationUrl: ({ redirectUri, state, nonce, codeChallenge }) =>
      client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        response_type: 'code',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
    exchange: async (currentUrl, checks): Promise<User> => {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('no ID token claims');
      const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
      return {
        id: str(claims['oid']) ?? String(claims.sub),
        name: str(claims['name']) ?? str(claims['preferred_username']) ?? String(claims.sub),
        email: str(claims['email']) ?? str(claims['preferred_username']),
      };
    },
  };
}
