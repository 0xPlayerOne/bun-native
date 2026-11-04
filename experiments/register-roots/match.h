/* Research matching only: never dereference a candidate pointer. */
#ifndef BN_ROOT_MATCH_H
#define BN_ROOT_MATCH_H
#include <stdint.h>
#include <stddef.h>

static int within_window(uint64_t value, uint64_t target, uint32_t width) {
    return target != 0 && width > 0 && width <= 256 && value >= target && value - target < width;
}

static uint32_t count_window(const uint64_t *values, size_t count, uint64_t target, uint32_t width) {
    uint32_t matches = 0;
    for (size_t index = 0; index < count; index++)
        if (within_window(values[index], target, width)) matches++;
    return matches;
}
#endif
