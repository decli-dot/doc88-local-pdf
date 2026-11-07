import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export function createHash() {
  const value = sha256.create();
  return {
    update(bytes) {
      value.update(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
      return this;
    },
    digest() {
      return bytesToHex(value.digest());
    },
  };
}
