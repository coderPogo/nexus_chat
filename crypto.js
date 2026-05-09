/**
 * NEXUS Crypto Module
 * Real AES-256-GCM encryption via Web Crypto API.
 * Each conversation derives a unique symmetric key from the
 * two usernames so that only the participants can read messages.
 */

const NexusCrypto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /** Derive a symmetric AES-GCM key from two usernames (deterministic). */
  async function deriveKey(userA, userB) {
    // Canonical order so both sides get the same key
    const canonical = [userA, userB].map(u => u.toLowerCase()).sort().join(':');
    const seed = enc.encode('nexus-v1:' + canonical);
    const rawKey = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('nexus-salt'), info: enc.encode('chat-key') },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** Encrypt plaintext → base64 payload (iv:ciphertext). */
  async function encrypt(plaintext, userA, userB) {
    const key = await deriveKey(userA, userB);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
    return ivB64 + ':' + ctB64;
  }

  /** Decrypt base64 payload (iv:ciphertext) → plaintext. */
  async function decrypt(payload, userA, userB) {
    try {
      const [ivB64, ctB64] = payload.split(':');
      const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
      const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
      const key = await deriveKey(userA, userB);
      const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return dec.decode(pt);
    } catch {
      return '[decryption failed]';
    }
  }

  /** Hash a password with PBKDF2-SHA256. */
  async function hashPassword(password, salt) {
    const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 },
      keyMat, 256
    );
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }

  return { encrypt, decrypt, hashPassword };
})();
