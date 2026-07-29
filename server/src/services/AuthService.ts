/**
 * Simple shared-secret authentication service.
 *
 * The server expects a single secret token (from TAMARI_SECRET env var)
 * on all mutation endpoints. Clients present it via:
 *   - REST: Authorization: Bearer <token> header or ?token=<token> query param
 *   - WebSocket: ?token=<token> query param in the connection URL
 */

export class AuthService {
  constructor(private secret: string) {}

  validate(token: string | undefined): boolean {
    if (!token || !this.secret) return false;
    // Use timing-safe comparison to prevent timing attacks
    if (token.length !== this.secret.length) return false;
    let result = 0;
    for (let i = 0; i < token.length; i++) {
      result |= token.charCodeAt(i) ^ this.secret.charCodeAt(i);
    }
    return result === 0;
  }
}
