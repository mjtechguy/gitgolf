package main

import "syscall"

// processAttributes puts a tool in its own process group (so cancel and deadline kill
// everything it started) and kills it if the host process dies.
func processAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
