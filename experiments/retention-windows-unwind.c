/* Failure-only own-thread root observation. Uses Windows unwind metadata rather
 * than assuming the pinned optimized native callers all retain frame pointers.
 * Emits only frame identities and exact target-word matches, never stack data.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>

/* output: header[8], frames[128][7], matches[128][3]. */
__declspec(dllexport) int observe(uint64_t target, uint64_t *output, int words) {
  CONTEXT context;
  DWORD64 image = 0;
  ULONG_PTR low = 0, high = 0;
  const int frame_offset = 8;
  const int hit_offset = 8 + 128 * 7;
  if (!target || !output || words < 8 + 128 * 7 + 128 * 3) return -1;
  RtlCaptureContext(&context);
  GetCurrentThreadStackLimits(&low, &high);
  DWORD64 initial = context.Rsp;
  if (initial < low || initial >= high || high - initial > (1u << 20)) return -2;
  output[0] = initial;
  output[1] = high;
  output[2] = (uint64_t)GetModuleHandleW(NULL);
  int count = 0;
  __try {
    while (count < 128 && context.Rsp >= initial && context.Rsp < high && context.Rip) {
      DWORD64 rsp = context.Rsp;
      DWORD64 rip = context.Rip;
      PRUNTIME_FUNCTION function = RtlLookupFunctionEntry(rip, &image, NULL);
      uint64_t *frame = output + frame_offset + count * 7;
      frame[0] = rip;
      frame[1] = rsp;
      frame[2] = function ? image : 0;
      frame[3] = function ? function->BeginAddress : 0;
      frame[4] = function ? function->EndAddress : 0;
      frame[5] = function ? function->UnwindData : 0;
      if (function) {
        PVOID data = NULL;
        DWORD64 establisher = 0;
        RtlVirtualUnwind(UNW_FLAG_NHANDLER, image, rip, function, &context, &data, &establisher, NULL);
        frame[6] = establisher;
      } else {
        if (rsp > high - sizeof(DWORD64)) break;
        context.Rip = *(const DWORD64 *)rsp;
        context.Rsp += sizeof(DWORD64);
        frame[6] = 0;
      }
      ++count;
      if (context.Rsp <= rsp || context.Rsp > high) break;
    }
    int hits = 0;
    for (DWORD64 slot = (initial + 7) & ~(DWORD64)7; slot <= high - 8; slot += 8) {
      DWORD64 value = *(const volatile DWORD64 *)slot;
      if (value != target && value != target + 1) continue;
      if (hits < 128) {
        uint64_t *hit = output + hit_offset + hits * 3;
        hit[0] = slot;
        hit[1] = value - target;
        int owner = -1;
        for (int n = 0; n < count; ++n) {
          DWORD64 bottom = output[frame_offset + n * 7 + 1];
          DWORD64 top = n + 1 < count ? output[frame_offset + (n + 1) * 7 + 1] : high;
          if (slot >= bottom && slot < top) { owner = n; break; }
        }
        hit[2] = (uint64_t)(int64_t)owner;
      }
      ++hits;
    }
    output[3] = (uint64_t)count;
    output[4] = (uint64_t)hits;
    output[5] = context.Rsp;
    output[6] = context.Rip;
    output[7] = (uint64_t)(context.Rip == 0 || context.Rsp == high);
  } __except(EXCEPTION_EXECUTE_HANDLER) { return -3; }
  return 0;
}
