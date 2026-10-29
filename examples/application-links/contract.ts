import { normalizeApplicationLinksManifest } from '../../packages/contracts/src/index.ts'

export const applicationLinkManifest = normalizeApplicationLinksManifest({
  schema: 1,
  routes: [{ scheme: 'bunly-test', host: 'open', path: '/item' }],
})
export const applicationLinkStartupInputs = Object.freeze([
  'bunly-test://open/item?value=first',
  'bunly-test://open/item?value=second%20input',
  'bunly-test://unlisted/item?value=rejected',
])
export const applicationLinkChecks = Object.freeze([
  'startupRouting',
  'missingGrantDenied',
  'forgedReaderDenied',
  'duplicateReaderDenied',
  'staleBatchDenied',
  'disposePreservesInput',
  'managedJournalRetained',
  'managedAcknowledgment',
  'navigationRevoked',
  'externalUrlDenied',
  'quitRemoval',
])
