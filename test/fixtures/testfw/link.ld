ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 64K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 20K
}

SECTIONS
{
  .isr_vector : { KEEP(*(.vectors)) } > FLASH
  .text : { *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT> FLASH
  .bss  : { *(.bss*) *(COMMON) } > RAM
  .stack (NOLOAD) : { . = ALIGN(8); . = . + 0x400; _estack = .; } > RAM
}
