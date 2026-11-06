# BN2 Solid native evidence

Local Linux correctness records for the Solid renderer. Each one uses a
development-profile GPUI host and software rendering. None of them is a
performance measurement or a hosted release result. The
[BN2 Solid integration report](../../docs/bn2-solid-integration.md) explains every
record and its limits.

| Record                                                                     | Scope                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`solid-native-correctness.json`](solid-native-correctness.json)           | Initial development-host native correctness observations                         |
| [`solid-native-regenerated.json`](solid-native-regenerated.json)           | Fresh correctness runs after the source was regenerated                          |
| [`solid-shared-native.json`](solid-shared-native.json)                     | Correctness on the shared renderer source                                        |
| [`solid-events-native.json`](solid-events-native.json)                     | Protocol-4 shared event props and Solid correctness                              |
| [`solid-events-regressions.json`](solid-events-regressions.json)           | Protocol-4 event regression cases                                                |
| [`solid-hosted-recipe-linux.json`](solid-hosted-recipe-linux.json)         | Local run of the required hosted Solid recipe                                    |
| [`solid-production-recipe-linux.json`](solid-production-recipe-linux.json) | All twelve native scenarios against production Solid modules and AOT executables |

The production recipe builds each Solid fixture with
`bun experiments/aot-gpui/build-window.ts --entry <solid entry>`. See the
[AOT build helper guide](../../experiments/aot-gpui/README.md#solid-development-and-aot-inputs)
for the commands.
