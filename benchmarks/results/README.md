# Recorded native results

| Record                                                                               | Content                                                                                                       | Explained in                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [`bn1-hosted-linux-release.json`](bn1-hosted-linux-release.json)                     | Extract of the BN1 required hosted release verification: digests, AOT identities, source checks, measurements | [BN1 audit](../../docs/bn1-audit.md)  |
| [`native-allocation-linux-dev.json`](native-allocation-linux-dev.json)               | Heaptrack summary of the native host over 1,000 public lifecycle cycles (development host)                    | [`ALLOCATIONS.md`](../ALLOCATIONS.md) |
| [`native-allocation-protocol4-oracle.json`](native-allocation-protocol4-oracle.json) | Protocol-4 click-oracle regression qualification of the allocation runner                                     | [`ALLOCATIONS.md`](../ALLOCATIONS.md) |

These are retained records. Allocation counts are instrumented observations, not
leak proofs or optimization measurements. To collect new allocation evidence, use
the `scripts/quality/native-allocation-linux.py` command in
[`ALLOCATIONS.md`](../ALLOCATIONS.md) with a fresh output directory.
