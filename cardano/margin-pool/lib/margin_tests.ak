use aiken/crypto.{Blake2b_224, Hash, Script, VerificationKeyHash}
use cardano/address.{Credential, Script as AddrScript, VerificationKey}
use cardano/transaction.{Output, Transaction, placeholder}

/// Script hash placeholder (28 bytes Blake2b-224 / Plutus script id size).
const dummy_script_hash: Hash<Blake2b_224, Script> =
  #"01020304050607080910111213141516171819202122232425262728"

test credential_script_extracts_script_hash() {
  let c: Credential = AddrScript(dummy_script_hash)
  when c is {
    AddrScript(h) -> h == dummy_script_hash
    VerificationKey(_) -> False
  }
}

test vkey_credential_has_no_script_hash() {
  let vk: VerificationKeyHash =
    #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  let c: Credential = VerificationKey(vk)
  when c is {
    AddrScript(_) -> False
    VerificationKey(_) -> True
  }
}

test placeholder_tx_has_empty_inputs() {
  placeholder.inputs == []
}
