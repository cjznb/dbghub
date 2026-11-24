.syntax unified
.cpu cortex-m3
.thumb

.section .vectors,"a",%progbits
.global vectors
vectors:
  .word 0x20005000        /* initial SP */
  .word Reset_Handler
  .word Default_Handler
  .word Default_Handler
  .word Default_Handler
  .word Default_Handler
  .word Default_Handler
  .word Default_Handler
  .word Default_Handler

.section .text.Reset_Handler,"ax",%progbits
.thumb_func
.global Reset_Handler
Reset_Handler:
  bl main
1: b 1b

.thumb_func
.global Default_Handler
Default_Handler:
1: b 1b
