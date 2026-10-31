#include <stdint.h>
#include <stdio.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define BN_EXPORT __declspec(dllexport)
#else
#define BN_EXPORT __attribute__((visibility("default")))
#endif

BN_EXPORT uint32_t bn_add(uint32_t left, uint32_t right) {
    return left + right;
}

BN_EXPORT uint32_t bn_call(uint32_t (*callback)(uint32_t, uint32_t),
                           uint32_t left, uint32_t right) {
    return callback(left, right);
}

#ifdef BUN_NATIVE_EXECUTABLE
// This is an interoperability fixture, not a renderer or simulated native UI.
int main(void) {
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
        _setmode(_fileno(stdout), _O_BINARY) == -1) return 4;
#endif
    char line[65536];
    while (fgets(line, sizeof(line), stdin) != NULL) {
        if (fputs(line, stdout) == EOF || fflush(stdout) != 0) return 2;
    }
    return ferror(stdin) ? 3 : 0;
}
#endif
