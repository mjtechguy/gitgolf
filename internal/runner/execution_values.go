package runner

import (
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const ExecutionValuesCapability = "golf.repository-env.v1"
const MaxExecutionValues = 64
const MaxExecutionValueBytes = 8192
const MaxExecutionEnvironmentBytes = 64 << 10

var executionName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var ErrExecutionValues = errors.New("repository execution environment is invalid")

// These keys are process/controller authority, not repository variables. The
// closed uppercase namespace also rejects mixed-case duplicates on host tools.
func ExecutionValueName(name string) bool {
	if !executionName.MatchString(name) {
		return false
	}
	switch name {
	case "PATH", "HOME", "ENV", "BASH_ENV", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "IFS", "CDPATH", "TMPDIR", "TMP", "TEMP", "HOSTNAME", "CI", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "PERL5OPT", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "GIT_CONFIG", "GIT_CONFIG_COUNT", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
		return false
	}
	for _, prefix := range []string{"GOLF_", "GITHUB_", "ACTIONS_", "RUNNER_", "ACT_", "DOCKER_", "LD_", "DYLD_", "XDG_", "GIT_", "SSH_", "NODE_", "BASH_", "PYTHON_", "SYSTEMD_"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}
func ExecutionValueBody(value string, secret bool) bool {
	minimum := 1
	if secret {
		minimum = 8
	}
	return len(value) >= minimum && len(value) <= MaxExecutionValueBytes && utf8.ValidString(value) && strings.IndexFunc(value, func(r rune) bool { return unicode.IsControl(r) || unicode.In(r, unicode.Zl, unicode.Zp) }) < 0
}

// Repository values travel only in the bounded execute envelope. They are
// absent from plan input, Docker/controller environment and command arguments.
type ExecutionEnvironment struct {
	Variables map[string]string `json:"variables"`
	Secrets   map[string]string `json:"secrets"`
}

func (e *ExecutionEnvironment) Validate() error {
	if e == nil {
		return nil
	}
	if len(e.Variables)+len(e.Secrets) < 1 || len(e.Variables)+len(e.Secrets) > MaxExecutionValues {
		return ErrExecutionValues
	}
	total := 0
	for name, value := range e.Variables {
		if !ExecutionValueName(name) || !ExecutionValueBody(value, false) {
			return ErrExecutionValues
		}
		total += len(value)
	}
	for name, value := range e.Secrets {
		if !ExecutionValueName(name) || !ExecutionValueBody(value, true) {
			return ErrExecutionValues
		}
		if _, exists := e.Variables[name]; exists {
			return ErrExecutionValues
		}
		total += len(value)
	}
	if total > MaxExecutionEnvironmentBytes {
		return ErrExecutionValues
	}
	return nil
}
