export { encodeFrame, FrameDecoder, MAX_FRAME_BYTES, ProtocolError } from './framing.ts'
export { parseElement, type Element, type Style } from './elements.ts'
export { MAX_TEXT_BYTES } from './values.ts'
export type { ServicePolicy } from './services.ts'
export {
  DEFAULT_LIMITS,
  ERROR_CODES,
  MAX_OPERATIONS,
  parseCommand,
  parseEvent,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type Command,
  type NativeEvent,
  type Operation,
  type Limits,
  type ErrorCode,
  type Capability,
  type KeyModifiers,
  type PointerButton,
} from './messages.ts'
