/* Minimal Cortex-M3 test firmware for dbghub/Renode e2e. */
volatile unsigned int tick_count;
volatile int last_value;

void tick(int x) {
  tick_count++;
  last_value = x;
}

int main(void) {
  int n = 0;
  for (;;) {
    tick(n++);
    for (volatile int i = 0; i < 1000; i++) { }
  }
}
