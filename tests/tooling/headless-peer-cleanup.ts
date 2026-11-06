// Test preload: remove the compiled headless peers once this process's tests
// finish (after the whole run serially, after each file in --parallel workers).
import { afterAll } from 'bun:test'
import { removeHeadlessPeers } from './headless-peer.ts'

afterAll(removeHeadlessPeers)
