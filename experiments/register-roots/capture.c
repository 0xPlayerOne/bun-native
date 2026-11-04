/* Own-process research only. Unwind this function once; do not walk JIT frames. */
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <intrin.h>
#include <stdint.h>
#include <string.h>
#include "match.h"

#if !defined(_M_X64)
#error This observer requires actual Windows x64.
#endif
#define API __declspec(dllexport)
#define SLOT_COUNT 16u
#define WORD_COUNT 32768u
#define GPR_COUNT 8u
#define SIMD_WORD_COUNT 20u

typedef struct {
    uint32_t sequence, valid, words, truncated;
    uint64_t start, caller_pc;
    uint64_t registers[GPR_COUNT];
    uint64_t simd[SIMD_WORD_COUNT];
    uint64_t stack[WORD_COUNT];
} Snapshot;
static Snapshot snapshots[SLOT_COUNT];
static uint32_t total;
static DWORD owner;

static Snapshot *lookup(uint32_t sequence) {
    Snapshot *value = &snapshots[sequence % SLOT_COUNT];
    return value->valid && value->sequence == sequence ? value : NULL;
}

API __declspec(noinline) uint32_t capture_stack(void) {
    CONTEXT context;
    DWORD64 image = 0, establisher = 0;
    PVOID handler = NULL;
    ULONG_PTR low = 0, high = 0;
    DWORD thread = GetCurrentThreadId();
    PRUNTIME_FUNCTION function;
    Snapshot *value;
    uint32_t sequence;
    if ((owner && owner != thread) || total == UINT32_MAX) return UINT32_MAX;
    owner = thread;
    RtlCaptureContext(&context);
    function = RtlLookupFunctionEntry(context.Rip, &image, NULL);
    if (!function) return UINT32_MAX;
    /* Recover registers saved by OUR compiled prologue. No guessed leaf unwind. */
    RtlVirtualUnwind(UNW_FLAG_NHANDLER, image, context.Rip, function,
                    &context, &handler, &establisher, NULL);
    GetCurrentThreadStackLimits(&low, &high);
    if (context.Rsp < low || context.Rsp >= high || context.Rsp % sizeof(uint64_t))
        return UINT32_MAX;
    sequence = total++;
    value = &snapshots[sequence % SLOT_COUNT];
    value->valid = 0;
    value->sequence = sequence;
    value->start = context.Rsp;
    value->caller_pc = context.Rip;
    value->registers[0] = context.Rbx;
    value->registers[1] = context.Rbp;
    value->registers[2] = context.Rdi;
    value->registers[3] = context.Rsi;
    value->registers[4] = context.R12;
    value->registers[5] = context.R13;
    value->registers[6] = context.R14;
    value->registers[7] = context.R15;
    /* Windows x64 preserves the lower 128 bits of XMM6-XMM15. */
    memcpy(value->simd, &context.Xmm6, sizeof(value->simd));
    value->truncated = (high - context.Rsp) / sizeof(uint64_t) > WORD_COUNT;
    value->words = value->truncated ? WORD_COUNT : (uint32_t)((high - context.Rsp) / sizeof(uint64_t));
    memcpy(value->stack, (const void *)(uintptr_t)context.Rsp, value->words * sizeof(uint64_t));
    value->valid = 1;
    return sequence;
}

static const uint64_t *bank_values(Snapshot *value, uint32_t bank, size_t *count) {
    if (bank == 0) { *count = value->words; return value->stack; }
    if (bank == 1) { *count = GPR_COUNT; return value->registers; }
    if (bank == 2) { *count = SIMD_WORD_COUNT; return value->simd; }
    *count = 0;
    return NULL;
}
API uint32_t snapshot_count(void) { return total; }
API uint32_t snapshot_valid(uint32_t sequence) { return lookup(sequence) != NULL; }
API uint32_t snapshot_words(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? value->words : 0;
}
API uint32_t snapshot_truncated(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? value->truncated : 1;
}
API uint64_t snapshot_start(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? value->start : 0;
}
API uint64_t snapshot_pc(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? value->caller_pc : 0;
}
API uint32_t match_count(uint32_t sequence, uint32_t bank, uint64_t target, uint32_t width) {
    Snapshot *value = lookup(sequence);
    size_t count = 0;
    const uint64_t *values;
    if (!value) return 0;
    values = bank_values(value, bank, &count);
    return count_window(values, count, target, width);
}
API uint32_t match_index(uint32_t sequence, uint32_t bank, uint64_t target, uint32_t width, uint32_t occurrence) {
    Snapshot *value = lookup(sequence);
    size_t count = 0;
    uint32_t seen = 0;
    const uint64_t *values;
    if (!value) return UINT32_MAX;
    values = bank_values(value, bank, &count);
    for (size_t index = 0; index < count; index++)
        if (within_window(values[index], target, width) && seen++ == occurrence)
            return (uint32_t)index;
    return UINT32_MAX;
}
API uint32_t match_delta(uint32_t sequence, uint32_t bank, uint64_t target, uint32_t width, uint32_t occurrence) {
    Snapshot *value = lookup(sequence);
    size_t count = 0;
    uint32_t index = match_index(sequence, bank, target, width, occurrence);
    const uint64_t *values;
    if (!value || index == UINT32_MAX) return UINT32_MAX;
    values = bank_values(value, bank, &count);
    return index < count ? (uint32_t)(values[index] - target) : UINT32_MAX;
}
API __declspec(noinline) uint32_t stack_control(void) {
    volatile uint64_t sentinel = UINT64_C(0x4b1d2876c503e9a2);
    uint32_t sequence = capture_stack();
    return match_count(sequence, 0, sentinel, 1);
}
API void reset_snapshots(void) {
    /* Clears the observer's private buffers only, never a VM or live stack. */
    SecureZeroMemory(snapshots, sizeof(snapshots));
    total = 0;
    owner = 0;
}
