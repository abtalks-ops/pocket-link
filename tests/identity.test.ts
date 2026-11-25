import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIdentity, randomNonce, signProof, verifyProof } from '../src/lib/identity';

describe('identity proof', () => {
  it('verifies a genuine proof and rejects a forged one', async () => {
    const a = await createIdentity('A');
    const nonce = randomNonce();
    const sig = await signProof(a, nonce, 'peer-b');
    expect(await verifyProof(a.publicJwk, nonce, a.id, 'peer-b', sig)).toBe(true);
    expect(await verifyProof(a.publicJwk, randomNonce(), a.id, 'peer-b', sig)).toBe(false); // replayed against a new nonce
    expect(await verifyProof(a.publicJwk, nonce, 'someone-else', 'peer-b', sig)).toBe(false); // claimed wrong id
  });
});
