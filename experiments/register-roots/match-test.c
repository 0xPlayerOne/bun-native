#include "match.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    const uint64_t values[] = {0, 4095, 4096, 4097, 4111, 4112, 4351, 4352, UINT64_MAX};
    assert(count_window(values, 9, 4096, 1) == 1);
    assert(count_window(values, 9, 4096, 16) == 3);
    assert(count_window(values, 9, 4096, 256) == 5);
    assert(count_window(values, 9, UINT64_MAX - 3, 16) == 1);
    assert(count_window(values, 9, 1000, 16) == 0);
    assert(count_window(values, 9, 0, 16) == 0);
    assert(count_window(values, 9, 4096, 0) == 0);
    assert(count_window(values, 9, 4096, 257) == 0);
    puts("8 bounded matching controls passed; no Windows capture claim");
    return 0;
}
