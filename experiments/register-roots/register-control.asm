; Synthetic non-pointer sentinel. Preserve the caller's real R12/XMM6 and stack.
EXTERN capture_stack:PROC
PUBLIC register_control
.code
register_control PROC FRAME
    push r12
    .pushreg r12
    sub rsp, 64
    .allocstack 64
    movdqu xmmword ptr [rsp+32], xmm6
    .savexmm128 xmm6, 32
    .endprolog
    mov r12, 04b1d2876c503e9a2h
    movq xmm6, r12
    call capture_stack
    movdqu xmm6, xmmword ptr [rsp+32]
    add rsp, 64
    pop r12
    ret
register_control ENDP
END
