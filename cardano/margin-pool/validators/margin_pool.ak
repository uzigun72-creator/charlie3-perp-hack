use aiken/collection/list
use aiken/crypto.{Blake2b_224, Hash, Script}
use cardano/address.{Credential, Script as AddrScript, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Output, OutputReference, Transaction, find_input, resolve_input,
}
use margin_types.{MergeDeposit, PoolDatum, PoolRedeemer, WithdrawClose}

fn credential_script_hash(c: Credential) -> Option<Hash<Blake2b_224, Script>> {
  when c is {
    AddrScript(h) -> Some(h)
    VerificationKey(_) -> None
  }
}

/// Exactly one output paying to `pool_hash` with inline pool datum.
fn find_continuing_pool_output(
  outputs: List<Output>,
  pool_hash: Hash<Blake2b_224, Script>,
) -> Option<Output> {
  list.find(
    outputs,
    fn(o) {
      when credential_script_hash(o.address.payment_credential) is {
        Some(h) ->
          if h == pool_hash {
            when o.datum is {
              InlineDatum(_) -> True
              _ -> False
            }
          } else {
            False
          }
        None -> False
      }
    },
  )
}

validator margin_pool {
  spend(
    datum: Option<PoolDatum>,
    redeemer: PoolRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d_in) = datum
    when redeemer is {
      MergeDeposit { margin_ref } -> {
        expect Some(margin_in) = find_input(tx.inputs, margin_ref)
        expect Some(margin_h) =
          credential_script_hash(margin_in.output.address.payment_credential)
        expect margin_h == d_in.margin_script_hash
        let margin_lovelace = assets.lovelace_of(margin_in.output.value)
        expect margin_lovelace > 0
        expect Some(pool_out) =
          find_continuing_pool_output(tx.outputs, d_in.pool_script_hash)
        expect InlineDatum(out_data) = pool_out.datum
        expect Some(d_out): Option<PoolDatum> = out_data
        expect d_out.pool_script_hash == d_in.pool_script_hash
        expect d_out.margin_script_hash == d_in.margin_script_hash
        expect d_out.admin == d_in.admin
        expect d_out.positions_root == d_in.positions_root
        expect d_out.merge_count == d_in.merge_count + 1
        expect
          d_out.total_margin_lovelace == d_in.total_margin_lovelace + margin_lovelace
        let pool_in = resolve_input(tx.inputs, own_ref)
        let pool_in_lovelace = assets.lovelace_of(pool_in.value)
        let pool_out_lovelace = assets.lovelace_of(pool_out.value)
        expect pool_out_lovelace >= pool_in_lovelace + margin_lovelace
        True
      }
      WithdrawClose { withdraw_lovelace } -> {
        expect withdraw_lovelace > 0
        expect withdraw_lovelace <= d_in.total_margin_lovelace
        expect list.any(tx.extra_signatories, fn(s) { s == d_in.admin })
        expect Some(pool_out) =
          find_continuing_pool_output(tx.outputs, d_in.pool_script_hash)
        expect InlineDatum(out_data) = pool_out.datum
        expect Some(d_out): Option<PoolDatum> = out_data
        expect d_out.pool_script_hash == d_in.pool_script_hash
        expect d_out.margin_script_hash == d_in.margin_script_hash
        expect d_out.admin == d_in.admin
        expect d_out.positions_root == d_in.positions_root
        expect d_out.merge_count == d_in.merge_count
        expect
          d_out.total_margin_lovelace == d_in.total_margin_lovelace - withdraw_lovelace
        let pool_in = resolve_input(tx.inputs, own_ref)
        let pool_in_lovelace = assets.lovelace_of(pool_in.value)
        let pool_out_lovelace = assets.lovelace_of(pool_out.value)
        expect pool_out_lovelace >= pool_in_lovelace - withdraw_lovelace
        True
      }
    }
  }

  else(_) {
    fail
  }
}
