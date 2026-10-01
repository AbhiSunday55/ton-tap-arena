// ── AGENT-OWNED: TON Connect 2.0 server integration ─────────────────────────
// Two jobs:
//   1. Verify a `ton_proof` the wallet signed, so a wallet↔account binding is
//      cryptographically proven rather than asserted by the client.
//   2. Build the transfer a wallet will sign for a shop purchase or withdrawal.
//
// MAJOR CAVEAT, enforced here rather than papered over: TON transfers require a
// 32-byte TON address. The treasury identifier given in the spec is a 20-byte
// EVM address, which TON CANNOT pay to. `assertTonTreasury()` therefore REFUSES
// to build a transfer while the admin-configured TON address is empty, instead
// of silently inventing or converting one.
import { Address, beginCell, Cell, loadStateInit } from "@ton/core";
import { sha256, signVerify } from "@ton/crypto";
import { NANO } from "../../shared/game-config";

const PROOF_PREFIX = "ton-proof-item-v2/";
const PROOF_DOMAIN = "ton-connect";
const PROOF_MAX_AGE_SECONDS = 15 * 60;

export interface TonProofPayload {
  /** Raw 32-byte Ed25519 public key, hex or base64. */
  publicKey?: string;
  /** Alternatively, the base64 state init the wallet returned. */
  walletStateInit?: string;
  /** Raw (0:hex / -1:hex) or friendly (EQ…/UQ…/kQ…) address the proof was made for. */
  address: string;
  network?: string;
  proof: {
    timestamp: number;
    domain: { lengthBytes: number; value: string };
    payload: string;
    signature: string; // base64, 64 bytes
  };
}

export type VerifyResult = { ok: true; address: string; publicKey: string } | { ok: false; reason: string };

/** SPKI DER prefix for a raw Ed25519 public key (RFC 8410). */
function publicKeyFromStateInit(walletStateInit: string): Buffer | null {
  try {
    const si = loadStateInit(Cell.fromBase64(walletStateInit).beginParse());
    if (!si.data) return null;
    const ds = si.data.beginParse();
    // Wallet v3/v4 data layout: seqno(32) | subwalletId(32) | publicKey(256)
    ds.loadUintBig(32);
    ds.loadUintBig(32);
    return ds.loadBuffer(32);
  } catch {
    return null;
  }
}

function decodePublicKey(input: TonProofPayload): Buffer | null {
  if (input.walletStateInit) {
    const fromState = publicKeyFromStateInit(input.walletStateInit);
    if (fromState) return fromState;
  }
  if (!input.publicKey) return null;
  const raw = input.publicKey.trim();
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  } catch {
    /* fall through to base64 */
  }
  try {
    const buf = Buffer.from(raw, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

export function isTonAddress(value: string): boolean {
  try {
    Address.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * Verify the ton_proof signature.
 *
 * The digest the wallet signs is:
 *   sha256(0xffff ++ "ton-connect" ++ sha256(
 *     "ton-proof-item-v2/" ++ workchain(int32 BE) ++ addressHash(32) ++
 *     domainLen(uint32 LE) ++ domain ++ timestamp(uint64 LE) ++ payload))
 */
export async function verifyTonProof(
  input: TonProofPayload,
  expected: { domain: string; payload: string; now?: Date },
): Promise<VerifyResult> {
  const now = expected.now ?? new Date();
  const proof = input?.proof;
  if (!proof) return { ok: false, reason: "no ton_proof supplied" };

  // 1. Nonce must be the one we issued for this session.
  if (!proof.payload || proof.payload !== expected.payload) {
    return { ok: false, reason: "proof payload does not match the issued nonce" };
  }

  // 2. Domain must match the app's own host (both spellings, so a wallet that
  //    reports the bare host or the full origin are both accepted).
  const host = expected.domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const signingHost = (proof.domain?.value ?? "").replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!signingHost || (signingHost !== host && !host.endsWith(signingHost))) {
    return { ok: false, reason: `proof domain "${signingHost}" does not match "${host}"` };
  }

  // 3. Freshness.
  const age = Math.abs(Math.floor(now.getTime() / 1000) - proof.timestamp);
  if (age > PROOF_MAX_AGE_SECONDS) {
    return { ok: false, reason: `proof is ${age}s old (max ${PROOF_MAX_AGE_SECONDS}s)` };
  }

  // 4. Address must parse as a real TON address.
  let address: Address;
  try {
    address = Address.parse(input.address);
  } catch {
    return { ok: false, reason: "address is not a valid TON address" };
  }

  const publicKey = decodePublicKey(input);
  if (!publicKey || publicKey.length !== 32) {
    return { ok: false, reason: "could not read a 32-byte Ed25519 public key from the wallet" };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(proof.signature, "base64");
  } catch {
    return { ok: false, reason: "signature is not valid base64" };
  }
  if (signature.length !== 64) return { ok: false, reason: "signature must be 64 bytes" };

  // ── rebuild the signed digest ──
  const wcBuf = Buffer.alloc(4);
  wcBuf.writeInt32BE(address.workChain);

  const domainBytes = Buffer.from(signingHost, "utf8");
  const domainLenBuf = Buffer.alloc(4);
  domainLenBuf.writeUInt32LE(domainBytes.length);

  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64LE(BigInt(proof.timestamp));

  const msg = Buffer.concat([
    Buffer.from(PROOF_PREFIX, "utf8"),
    wcBuf,
    address.hash,
    domainLenBuf,
    domainBytes,
    tsBuf,
    Buffer.from(proof.payload, "utf8"),
  ]);

  const msgHash = await sha256(msg);
  const finalHash = await sha256(
    Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from(PROOF_DOMAIN, "utf8"), msgHash]),
  );

  let valid = false;
  try {
    valid = signVerify(finalHash, signature, publicKey);
  } catch (e) {
    return { ok: false, reason: `signature check failed: ${(e as Error).message}` };
  }
  if (!valid) return { ok: false, reason: "Ed25519 signature does not match the wallet public key" };

  return {
    ok: true,
    address: address.toRawString(),
    publicKey: publicKey.toString("hex"),
  };
}

/**
 * Refuse to build a transfer until the admin has supplied a TON-format
 * treasury address. Throws with a message written for the operator.
 */
export function assertTonTreasury(treasureTonAddress: string, treasuryEvm: string): string {
  const ton = (treasureTonAddress ?? "").trim();
  if (ton && isTonAddress(ton)) return ton;
  const why = ton
    ? `"${ton}" is not a valid TON address.`
    : "no TON treasury address is configured.";
  throw new Error(
    `TON payout rail is not armed: ${why} ` +
      `The canonical treasury ${treasuryEvm} is a 20-byte EVM address and TON transfers cannot be ` +
      `sent to it, so nothing is broadcast rather than guessing an address. ` +
      `Set a 32-byte TON address (EQ…/UQ…/0:hex) in Admin → Identity & Treasury to enable it.`,
  );
}

/** A plain transfer comment body — the standard uint32-zero + string-tail cell. */
export function commentPayload(text: string): string {
  return beginCell()
    .storeUint(0, 32)
    .storeStringTail(text.slice(0, 120))
    .endCell()
    .toBoc()
    .toString("base64");
}

/** nanoTON → a TON string the wallet UI shows, without float drift. */
export function nanoTonToTonString(nano: number): string {
  const whole = Math.floor(nano / NANO);
  const frac = (nano % NANO).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Short display form of a raw/friendly TON address. */
export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}
