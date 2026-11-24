/* Debuggee for the optional real-gdb integration test (test/gdb/gdb-real.test.mjs).
 * Built with clang + lld and DWARF debug info on demand; deliberately has no
 * includes so it can be compiled without a full SDK setup:
 *   clang -g -gdwarf -O0 -fuse-ld=lld -Wl,/debug:dwarf sample.c -o sample.exe
 */
typedef unsigned long DWORD;
__declspec(dllimport) void __stdcall Sleep(DWORD ms);

static volatile int counter;

int add(int a, int b) {
    return a + b;
}

int crunch(int n) {
    int s = 0;
    int i;
    for (i = 0; i < n; i++) {
        s = add(s, i);
        counter = s;
    }
    return s;
}

int main(void) {
    int r = crunch(8);
    Sleep(1500);
    r = add(r, 1);
    return r & 1;
}
