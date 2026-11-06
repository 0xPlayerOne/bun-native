# Benchmark evidence

| Record                                                           | Content                                                                                      | Explained in                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| [`bridge-pairs-41245052954.json`](bridge-pairs-41245052954.json) | Compact record of the first hosted BN1/native-events bridge-pair collection (issue #297)     | [`BRIDGE_PAIRS.md`](../BRIDGE_PAIRS.md) |
| [`react-linux-lifecycle.json`](react-linux-lifecycle.json)       | Local React lifecycle correctness and acknowledgement diagnostics (development-profile host) | [`REACT.md`](../REACT.md)               |

`benchmarks/audit-bridge-pairs.py` checks the bridge-pair record against the
original hosted artifacts and recomputes its statistics. [`BRIDGE_PAIRS.md`](../BRIDGE_PAIRS.md#reproduce-the-offline-audit)
gives the exact command. Neither record is a release performance baseline.
