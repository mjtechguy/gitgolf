package runner

import (
	"context"
	"net"
	"strings"
)

// The owned privileged daemon installs and reads back its packet boundary
// before source enters it. Source jobs have no NET_ADMIN/RAW capability. IPv6
// forwarding is disabled by dockerd's default, and explicitly dropped here.
func (a *ActionsExecutor) fenceDependencyNetwork(ctx context.Context, container string, access ActionDependencyAccess) error {
	if access.Validate() != nil || !containerPattern.MatchString(container) {
		return ErrInvalidJob
	}
	host, port, _ := net.SplitHostPort(access.Address)
	const script = `set -eu
iptables -N GOLF-JOB-EGRESS
iptables -A GOLF-JOB-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A GOLF-JOB-EGRESS -d "$1" -p tcp --dport "$2" -j ACCEPT
iptables -A GOLF-JOB-EGRESS -j DROP
iptables -I FORWARD 1 -j GOLF-JOB-EGRESS
iptables -I DOCKER-USER 1 -j GOLF-JOB-EGRESS
iptables -I OUTPUT 1 -j GOLF-JOB-EGRESS
iptables -I OUTPUT 1 -o lo -j ACCEPT
iptables -I INPUT 1 -j DROP
iptables -I INPUT 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -I INPUT 1 -i lo -j ACCEPT
ip6tables -I FORWARD 1 -j DROP
ip6tables -I OUTPUT 1 -j DROP
ip6tables -I INPUT 1 -j DROP
iptables -S GOLF-JOB-EGRESS
iptables -S FORWARD
iptables -S DOCKER-USER
iptables -S OUTPUT
iptables -S INPUT
echo GOLF-IPV6
ip6tables -S FORWARD
ip6tables -S OUTPUT
ip6tables -S INPUT
`
	body, err := a.executor.command(ctx, nil, "exec", container, "/bin/sh", "-ec", script, "golf-egress", host, port)
	if err != nil || !ValidDependencyFirewall(string(body), host, port) {
		return ErrInfrastructure
	}
	return nil
}

const DependencyFirewallReadback = "set -e; iptables -S GOLF-JOB-EGRESS; iptables -S FORWARD; iptables -S DOCKER-USER; iptables -S OUTPUT; iptables -S INPUT; echo GOLF-IPV6; ip6tables -S FORWARD; ip6tables -S OUTPUT; ip6tables -S INPUT"

func ValidDependencyFirewall(body, host, port string) bool {
	ipv4, ipv6, ok := strings.Cut(strings.TrimSpace(body), "\nGOLF-IPV6\n")
	if !ok || strings.Contains(ipv6, "GOLF-IPV6") {
		return false
	}
	v6 := map[string]bool{}
	for _, line := range strings.Split(ipv6, "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[0] == "-A" {
			if parts[1] != "FORWARD" && parts[1] != "OUTPUT" && parts[1] != "INPUT" {
				return false
			}
			if !v6[parts[1]] && (len(parts) != 4 || parts[2] != "-j" || parts[3] != "DROP") {
				return false
			}
			v6[parts[1]] = true
		} else if len(parts) != 3 || parts[0] != "-P" {
			return false
		}
	}
	if len(v6) != 3 || !v6["FORWARD"] || !v6["OUTPUT"] || !v6["INPUT"] {
		return false
	}
	lines := strings.Split(ipv4, "\n")
	want := []string{"-N GOLF-JOB-EGRESS", "-A GOLF-JOB-EGRESS -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT", "-A GOLF-JOB-EGRESS -d " + host + "/32 -p tcp -m tcp --dport " + port + " -j ACCEPT", "-A GOLF-JOB-EGRESS -j DROP"}
	if len(lines) < len(want) {
		return false
	}
	for i, w := range want {
		if lines[i] != w {
			return false
		}
	}
	first := map[string][]string{}
	for _, line := range lines[4:] {
		parts := strings.Fields(line)
		if len(parts) >= 3 && parts[0] == "-A" {
			first[parts[1]] = append(first[parts[1]], line)
		}
	}
	for chain, prefix := range map[string][]string{
		"FORWARD":     {"-A FORWARD -j GOLF-JOB-EGRESS"},
		"DOCKER-USER": {"-A DOCKER-USER -j GOLF-JOB-EGRESS"},
		"OUTPUT":      {"-A OUTPUT -o lo -j ACCEPT", "-A OUTPUT -j GOLF-JOB-EGRESS"},
		"INPUT":       {"-A INPUT -i lo -j ACCEPT", "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT", "-A INPUT -j DROP"},
	} {
		if len(first[chain]) < len(prefix) {
			return false
		}
		for i, w := range prefix {
			if first[chain][i] != w {
				return false
			}
		}
	}
	return true
}
