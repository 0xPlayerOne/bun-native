/** Fixed contributor workload. These constants describe expected fixture bytes, never transfer progress. */
export const DOWNLOAD_WORKLOAD_MS = 25_000
export const downloadFixtureSteps = [
  'complete',
  'explicit-replace-large',
  'allowed-redirect',
  'denied-redirect',
  'cancel',
  'abort',
  'unknown-size-limit',
  'transfer-timeout',
  'network-interruption',
  'navigation-cancel',
  'renderer-reload-cancel',
  'view-close-cancel',
  'window-close-cancel',
  'quit-cancel',
] as const
export const downloadFixturePayloads = Object.freeze({
  small: Object.freeze({
    bytes: 32 * 1024,
    seed: 11,
    sha256: '4daba74b0ccc9f1971db4376f8e7c3f6da921c29c39c9281c9aeb7b10023c13a',
  }),
  large: Object.freeze({
    bytes: 4 * 1024 * 1024,
    seed: 23,
    sha256: 'c9b91ff6ee35aa20653f8f4318652971b3ba8efe5ce0aea42e272381af39cfef',
  }),
})
