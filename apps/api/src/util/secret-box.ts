// Envelope encryption for user-supplied upstream credentials. Keys are
// encrypted with AES-GCM under a worker secret (BYOK_ENCRYPTION_KEY) and
// stored as base64(iv || ciphertext). The secret never leaves the worker;
// D1 only ever sees ciphertext.

const KEY_CACHE = new Map<string, CryptoKey>();

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const cached = KEY_CACHE.get(secret);
  if (cached) return cached;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  KEY_CACHE.set(secret, key);
  return key;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return toBase64(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]));
}

export async function decryptSecret(encoded: string, secret: string): Promise<string | null> {
  try {
    const bytes = fromBase64(encoded);
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const key = await encryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong secret, corrupted row, or truncated value: treat as unusable.
    return null;
  }
}
