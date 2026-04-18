use aiken/collection/list
use cardano/transaction.{OutputReference, Transaction}
use margin_types.{ForwardToPool, MarginDatum, MarginRedeemer, Refund}

validator margin_vault {
  spend(
    datum: Option<MarginDatum>,
    redeemer: MarginRedeemer,
    _utxo: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Refund -> list.any(tx.extra_signatories, fn(s) { s == d.owner })
      ForwardToPool -> list.any(tx.extra_signatories, fn(s) { s == d.owner })
    }
  }

  else(_) {
    fail
  }
}
