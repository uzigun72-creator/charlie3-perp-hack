use aiken/crypto.{Blake2b_224, Hash, Script, VerificationKeyHash}
use cardano/transaction.{OutputReference}

/// User margin locked at `margin_vault` before merge into the pool.
pub type MarginDatum {
  /// Must sign any spend (refund or forward to pool).
  owner: VerificationKeyHash,
  /// Opaque market id (e.g. UTF-8 "ADA-USD").
  market_id: ByteArray,
  /// Unique nonce for this deposit.
  position_nonce: ByteArray,
  /// 32-byte order commitment (Midnight / off-chain ticket), may be empty.
  order_commitment: ByteArray,
}

pub type MarginRedeemer {
  /// Unlock to arbitrary outputs — owner must co-sign.
  Refund
  /// Spend into same tx as `margin_pool` merge — owner must co-sign.
  ForwardToPool
}

/// Singleton pool UTxO: aggregate margin accounting (ADA-only v1).
pub type PoolDatum {
  /// Blake2b-224 hash of this pool spending script (continuing outputs must use this credential).
  pool_script_hash: Hash<Blake2b_224, Script>,
  /// Expected `margin_vault` script hash for inputs merged via `MergeDeposit`.
  margin_script_hash: Hash<Blake2b_224, Script>,
  /// Can authorize `WithdrawClose`.
  admin: VerificationKeyHash,
  /// Sum of merged margin (lovelace) — informational; must match merge steps.
  total_margin_lovelace: Int,
  /// Number of successful merges.
  merge_count: Int,
  /// Merkle root of open positions (opaque v1).
  positions_root: ByteArray,
}

pub type PoolRedeemer {
  /// Spend pool + the margin UTxO identified by this reference (robust when fee inputs reorder `inputs`).
  MergeDeposit { margin_ref: OutputReference }
  /// Admin reduces pooled total; pool continues at same script with lower `total_margin_lovelace`.
  WithdrawClose { withdraw_lovelace: Int }
}
