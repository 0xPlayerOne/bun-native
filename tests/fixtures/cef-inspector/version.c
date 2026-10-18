/* ABI test fixture only. This is NOT CEF and never enters baseline measurements. */
#include <stdlib.h>
int cef_version_info(int entry) {
#ifdef FIXTURE_ABORT
  abort();
#endif
  static const int parts[] = {123, 4, 5, 6, 123, 0, 4567, 89};
  return entry >= 0 && entry < 8 ? parts[entry] : -1;
}
const char *cef_version_full(void) {
  return "123.4.5+g123abcd+chromium-123.0.4567.89";
}
