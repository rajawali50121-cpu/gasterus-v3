import { requiredSecret } from '../backend/src/env.js';

const REQUIRED_SECURITY_SECRETS = [
  ['MEMBER_PROXY_SECRET', 32],
  ['ADMIN_PROXY_SECRET', 32],
  ['OPS_INTERNAL_SECRET', 32],
  ['SESSION_HMAC_KEY', 32],
  ['API_KEY_PEPPER', 32],
  ['MFA_ENCRYPTION_KEY_BASE64', 40],
];

export function validateSecuritySecrets() {
  for (const [name, minimumLength] of REQUIRED_SECURITY_SECRETS) {
    const value = requiredSecret(name, minimumLength);
    if (name === 'MFA_ENCRYPTION_KEY_BASE64' && Buffer.from(value, 'base64').length !== 32) {
      throw new Error(`${name} must decode to exactly 32 bytes`);
    }
  }
}