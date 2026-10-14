//go:build unix && !linux

package main

import "syscall"

// processAttributes puts a tool in its own process group so cancel and deadline kill
// everything it started.
func processAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
