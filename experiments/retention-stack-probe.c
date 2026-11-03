/* Research-only bounded frame scan of this process's current thread.
 * The conservative-root investigation method follows oven-sh/bun PR #46701.
 * Only frame addresses and exact target-word matches leave this helper.
 */
typedef unsigned long long u64;

u64 current_frame(void) { return (u64)__builtin_frame_address(0); }

int frames(u64 low, u64 high, u64 *output, int capacity) {
  u64 *frame = (u64 *)__builtin_frame_address(0);
  if (capacity < 1 || capacity > 256 || high <= low || high - low > (32ull << 20)) return -1;
  int count = 0;
  while (count < capacity) {
    u64 at = (u64)frame;
    if (at < low || at > high - 16 || (at & 7)) break;
    output[count * 2] = at;
    output[count * 2 + 1] = frame[1];
    ++count;
    u64 next = frame[0];
    if (next <= at || next - at > (1ull << 20) || next > high - 16 || (next & 7)) break;
    frame = (u64 *)next;
  }
  return count;
}

int matches(u64 low, u64 high, u64 target, u64 *output, int capacity) {
  if (!target || high <= low || high - low > (1ull << 20) || (low & 7) || (high & 7) || capacity < 1 || capacity > 128) return -1;
  int count = 0;
  for (u64 at = low; at < high; at += 8) {
    u64 value = *(const volatile u64 *)at;
    if (value == target || value == target + 1) {
      if (count < capacity) {
        output[count * 2] = at;
        output[count * 2 + 1] = value;
      }
      ++count;
    }
  }
  return count;
}

/* Outside acceptance: erase only this helper's own dead stack after failure. */
void clear_dead_stack(int depth) {
  volatile u64 storage[256];
  for (int i = 0; i < 256; ++i) storage[i] = 0;
  if (depth > 1 && depth <= 16) clear_dead_stack(depth - 1);
}
