'use strict';

// ---------------------------------------------------------------------------
// Sign-In-With-Ethereum helpers.
//
// The browser proves it controls a wallet address by signing a one-time
// message with it (MetaMask `personal_sign`). We recover the signer address
// from the signature server-side and check it matches the claimed address.
// No passwords, no private keys ever leave the wallet.
// ---------------------------------------------------------------------------
const { verifyMessage, getAddress, isAddress } = require('ethers');

// Deterministic message the wallet is asked to sign. Includes a server-issued
// nonce so a captured signature can't be replayed.
function buildMessage(siteName, address, nonce) {
  return [
    `${siteName} — sign in`,
    '',
    'Signing this proves you own this wallet. It costs no gas and sends no funds.',
    `Address: ${address}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

// Returns the checksummed signer address if the signature is valid for the
// message, else null.
function recoverSigner(message, signature) {
  try {
    return verifyMessage(message, signature);
  } catch (_) {
    return null;
  }
}

function normalizeAddress(address) {
  try {
    return isAddress(address) ? getAddress(address) : null; // checksummed, or null
  } catch (_) {
    return null;
  }
}

module.exports = { buildMessage, recoverSigner, normalizeAddress };
