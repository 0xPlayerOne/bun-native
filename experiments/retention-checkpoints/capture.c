/* Research-only, own-process pre-collection stack copies. Never exports raw bytes. */
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <intrin.h>
#include <stdint.h>
#include <string.h>

#define SLOT_COUNT 16u
#define WORD_COUNT 32768u
#define FRAME_COUNT 32u
#define API __declspec(dllexport)

typedef struct {
    uint32_t sequence;
    uint32_t valid;
    uintptr_t start;
    size_t words;
    uint32_t truncated;
    uint32_t frames;
    void *returns[FRAME_COUNT];
    uintptr_t saved[WORD_COUNT];
} Snapshot;

static Snapshot snapshots[SLOT_COUNT];
static uint32_t total;
static DWORD owner;

static Snapshot *lookup(uint32_t sequence) {
    Snapshot *value = &snapshots[sequence % SLOT_COUNT];
    return value->valid && value->sequence == sequence ? value : NULL;
}

API __declspec(noinline) uint32_t capture_stack(void) {
    ULONG_PTR low = 0, high = 0;
    uintptr_t start = (uintptr_t)_AddressOfReturnAddress();
    DWORD thread = GetCurrentThreadId();
    if ((owner && owner != thread) || total == UINT32_MAX) return UINT32_MAX;
    owner = thread;
    GetCurrentThreadStackLimits(&low, &high);
    if (start < low || start >= high || start % sizeof(uintptr_t)) return UINT32_MAX;
    uint32_t sequence = total++;
    Snapshot *value = &snapshots[sequence % SLOT_COUNT];
    value->valid = 0;
    value->sequence = sequence;
    value->start = start;
    value->words = (high - start) / sizeof(uintptr_t);
    value->truncated = value->words > WORD_COUNT;
    if (value->words > WORD_COUNT) value->words = WORD_COUNT;
    /* The range lies wholly above this thread's live stack pointer and below
       its stack base. No target pointer has been obtained or passed here. */
    memcpy(value->saved, (const void *)start, value->words * sizeof(uintptr_t));
    value->frames = (uint32_t)CaptureStackBackTrace(0, FRAME_COUNT, value->returns, NULL);
    value->valid = 1;
    return sequence;
}

API uint32_t snapshot_count(void) { return total; }
API uint32_t snapshot_valid(uint32_t sequence) { return lookup(sequence) != NULL; }
API uint64_t snapshot_start(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? (uint64_t)value->start : 0;
}
API uint32_t snapshot_words(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? (uint32_t)value->words : 0;
}
API uint32_t snapshot_truncated(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? value->truncated : 1;
}
API uint32_t snapshot_frames(uint32_t sequence) {
    Snapshot *value = lookup(sequence);
    return value ? value->frames : 0;
}
API uint64_t snapshot_return(uint32_t sequence, uint32_t index) {
    Snapshot *value = lookup(sequence);
    return value && index < value->frames ? (uint64_t)(uintptr_t)value->returns[index] : 0;
}
API uint32_t match_count(uint32_t sequence, uint64_t target) {
    Snapshot *value = lookup(sequence);
    uint32_t count = 0;
    if (!value) return 0;
    for (size_t index = 0; index < value->words; index++)
        if (value->saved[index] == (uintptr_t)target) count++;
    return count;
}
API uint64_t match_offset(uint32_t sequence, uint64_t target, uint32_t occurrence) {
    Snapshot *value = lookup(sequence);
    uint32_t count = 0;
    if (!value) return UINT64_MAX;
    for (size_t index = 0; index < value->words; index++) {
        if (value->saved[index] == (uintptr_t)target && count++ == occurrence)
            return (uint64_t)(index * sizeof(uintptr_t));
    }
    return UINT64_MAX;
}
API uint64_t executable_base(void) { return (uint64_t)(uintptr_t)GetModuleHandleW(NULL); }
API __declspec(noinline) uint32_t sentinel_control(void) {
    volatile uint64_t sentinel = UINT64_C(0x4b1d2876c503e9a2);
    uint32_t sequence = capture_stack();
    return match_count(sequence, sentinel);
}
API void reset_snapshots(void) {
    SecureZeroMemory(snapshots, sizeof(snapshots));
    total = 0;
    owner = 0;
}
