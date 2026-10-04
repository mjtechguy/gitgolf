package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	engine "github.com/mjtechguy/golf-git/engines/act"
	protocol "github.com/mjtechguy/golf-git/internal/runner"
)

func run() error {
	if len(os.Args) != 2 || (os.Args[1] != "plan" && os.Args[1] != "execute") {
		return errors.New("invalid engine command")
	}
	input := bufio.NewReaderSize(os.Stdin, 64<<10)
	line, err := readLine(input, 24<<20)
	if err != nil {
		return err
	}
	decode := func(data []byte, out any) error {
		d := json.NewDecoder(bytes.NewReader(data))
		d.DisallowUnknownFields()
		if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
			return errors.New("invalid engine input")
		}
		return nil
	}
	if os.Args[1] == "plan" {
		var req protocol.ActionPlanInput
		if decode(line, &req) != nil {
			return errors.New("invalid engine input")
		}
		plan, err := engine.Plan(req)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(plan)
	}
	var req protocol.ActionExecutionInput
	if decode(line, &req) != nil {
		return errors.New("invalid engine input")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return engine.Execute(ctx, req, func(event protocol.ActionFrame) error {
		if json.NewEncoder(os.Stdout).Encode(event) != nil {
			return errors.New("engine observation refused")
		}
		line, err := readLine(input, 128)
		if err != nil {
			return err
		}
		var ack protocol.ActionAck
		if decode(line, &ack) != nil || ack.Sequence != event.Sequence {
			return errors.New("engine observation refused")
		}
		return nil
	})
}
func readLine(r *bufio.Reader, max int) ([]byte, error) {
	var result []byte
	for {
		part, prefix, err := r.ReadLine()
		if err != nil || len(result)+len(part) > max {
			return nil, errors.New("engine input bounds")
		}
		result = append(result, part...)
		if !prefix {
			return result, nil
		}
	}
}
func main() {
	if err := run(); err != nil {
		if errors.Is(err, engine.ErrEvent) {
			fmt.Fprintln(os.Stderr, "Actions event not matched.")
			os.Exit(2)
		}
		if errors.Is(err, engine.ErrProfile) {
			fmt.Fprintln(os.Stderr, "Actions source is outside the selected profile.")
			os.Exit(3)
		}
		fmt.Fprintln(os.Stderr, "Actions engine operation refused or unconfirmed.")
		os.Exit(1)
	}
}
