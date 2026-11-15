/* Diagnostic positive control: keep one supplied pointer-shaped value on a
 * native stack while the caller requests a heap snapshot. No memory is read
 * through the value, and no scanned stack contents or slot addresses leave. */
typedef unsigned long long pin_u64;
#if defined(_WIN32)
#define PIN_EXPORT __declspec(dllexport)
#else
#define PIN_EXPORT __attribute__((visibility("default")))
#endif

PIN_EXPORT pin_u64 pin_during_callback(pin_u64 value, void (*callback)(void))
{
    volatile pin_u64 slot = value;
    callback();
    return slot;
}
