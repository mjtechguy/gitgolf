package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	proof "golf.local/actions-engine-qualification"
)

func main() {
	image := flag.String("image-id", "", "Exact already-local config image ID")
	caseName := flag.String("case", "graph", "Owned graph, failure, cancel or terminate fixture")
	event := flag.String("event", "workflow_dispatch", "Owned manual or push event")
	flag.Parse()
	receipt, err := proof.RunOffline(*image, *caseName, *event)
	if json.NewEncoder(os.Stdout).Encode(receipt) != nil {
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "FAIL: offline owned runtime qualification: "+err.Error())
		os.Exit(1)
	}
}
