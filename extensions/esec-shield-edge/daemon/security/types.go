package security

import "encoding/json"

type Decision string

const (
	DecisionAllow Decision = "allow"
	DecisionAsk   Decision = "ask"
	DecisionDeny  Decision = "deny"
)

type ParseKind string

const (
	ParseSimple      ParseKind = "simple"
	ParseTooComplex  ParseKind = "too-complex"
	ParseUnavailable ParseKind = "parse-unavailable"
)

type Redirect struct {
	Op     string `json:"op"`
	Target string `json:"target"`
	FD     *int   `json:"fd,omitempty"`
}

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type SimpleCommand struct {
	Argv      []string   `json:"argv"`
	EnvVars   []EnvVar   `json:"envVars"`
	Redirects []Redirect `json:"redirects"`
	Text      string     `json:"text"`
}

type CheckResult struct {
	Decision  Decision        `json:"decision"`
	Reason    string          `json:"reason"`
	Source    string          `json:"source"`
	RuleID    string          `json:"ruleId,omitempty"`
	Commands  []SimpleCommand `json:"commands,omitempty"`
	ParseKind ParseKind       `json:"parseKind"`
	Params    map[string]any  `json:"params,omitempty"`
}

type ToolContext struct {
	CurrentSessionKey string
	CurrentAgentID    string
	CWD               string
	Mode              string
}

type CommandRule struct {
	ID                   string   `json:"id"`
	MatchType            string   `json:"matchType"`
	Prefix               string   `json:"prefix"`
	BaseCommand          string   `json:"baseCommand"`
	RequiredSubCommand   string   `json:"requiredSubCommand"`
	RequiredSubCommands  []string `json:"requiredSubCommands"`
	RequiredArgBasenames []string `json:"requiredArgBasenames"`
	ForbiddenFlags       []string `json:"forbiddenFlags"`
	TargetScope          string   `json:"targetScope"`
	Action               Decision `json:"action"`
	Reason               string   `json:"reason"`
}

// PathDetectionRule 路径检测策略规则
type PathDetectionRule struct {
	ID         string   `json:"id"`
	Decision   string   `json:"decision"`
	Operations []string `json:"operations"`
	Pattern    string   `json:"pattern"`
	Reason     string   `json:"reason"`
	Risk       string   `json:"risk"`
}

// PathDetectionPolicy 路径检测策略配置
type PathDetectionPolicy struct {
	Meta        string              `json:"meta"`
	Description string              `json:"description"`
	PolicyRules []PathDetectionRule `json:"policyRules"`
}

type PathPolicy struct {
	AllowReadDirs        []string `json:"allowReadDirs"`
	AllowWriteDirs       []string `json:"allowWriteDirs"`
	SensitiveReadPaths   []string `json:"sensitiveReadPaths"`
	SensitiveReadFiles   []string `json:"sensitiveReadFiles"`
	SensitiveWritePaths  []string `json:"sensitiveWritePaths"`
	DenyPaths            []string `json:"denyPaths"`
	DangerousFiles       []string `json:"dangerousFiles"`
	DangerousDirectories []string `json:"dangerousDirectories"`
}

// CommandWhiteDetectionRule 命令白名单检测规则
type CommandWhiteDetectionRule struct {
	ID          string `json:"id"`
	Decision    string `json:"decision"`
	Pattern     string `json:"pattern"`
	Flags       string `json:"flags,omitempty"`
	Reason      string `json:"reason"`
	Risk        string `json:"risk"`
	PolicyLevel int    `json:"policyLevel,omitempty"`
}

// CommandWhiteDetectionPolicy 命令白名单检测策略配置
type CommandWhiteDetectionPolicy struct {
	Meta        string                      `json:"meta"`
	Description string                      `json:"description"`
	PolicyRules []CommandWhiteDetectionRule `json:"policyRules"`
}

type Policy struct {
	ProtectedTools        []string
	Mode                  string
	Path                  PathPolicy
	PathDetection         PathDetectionPolicy
	CommandRules          []CommandRule
	CommandWhiteDetection CommandWhiteDetectionPolicy
	InternalHosts         []string
	InternalSuffix        []string
	PowerShell            PowerShellPolicy
	ToolPolicy            ToolPolicy
}

type PluginConfig struct {
	PluginEnabled bool            `json:"pluginEnabled"`
	Mode          string          `json:"mode"`
	Policy        json.RawMessage `json:"policy"`
}

type nativePolicyDocument struct {
	ProtectedTools        []string `json:"protectedTools"`
	Mode                  string   `json:"mode"`
	Path                  PathPolicy
	PathDetection         PathDetectionPolicy         `json:"pathDetection"`
	CommandWhiteDetection CommandWhiteDetectionPolicy `json:"commandWhiteDetection"`
	Tools                 struct {
		Exec struct {
			Shell struct {
				UseBuiltinCommandRules bool          `json:"useBuiltinCommandRules"`
				CommandRules           []CommandRule `json:"commandRules"`
				InternalHosts          []string      `json:"internalHosts"`
				InternalHostSuffixes   []string      `json:"internalHostSuffixes"`
			} `json:"shell"`
			PowerShell PowerShellPolicy `json:"powershell"`
		} `json:"exec"`
		Gateway       namedActions        `json:"gateway"`
		Cron          cronPolicyJSON      `json:"cron"`
		SessionsSpawn sessionsSpawnPolicy `json:"sessionsSpawn"`
		SessionsSend  sessionsSendPolicy  `json:"sessionsSend"`
		Subagents     namedActions        `json:"subagents"`
		Nodes         namedActions        `json:"nodes"`
	} `json:"tools"`
}

type PowerShellPolicy struct {
	Executables            []string `json:"executables"`
	DispatchWrappers       []string `json:"dispatchWrappers"`
	DirectHighRiskCmdlets  []string `json:"directHighRiskCmdlets"`
	DangerousScriptCmdlets []string `json:"dangerousScriptBlockCmdlets"`
	Patterns               map[string]string
	InvocationHits         map[string]hitPolicy `json:"invocationHits"`
	ScriptHits             map[string]hitPolicy `json:"scriptHits"`
}

type hitPolicy struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type ToolPolicy struct {
	Named         map[string]namedActions
	Cron          cronPolicyJSON
	SessionsSpawn sessionsSpawnPolicy
	SessionsSend  sessionsSendPolicy
}

type namedActions struct {
	AllowActions        []string `json:"allowActions"`
	MutateActions       []string `json:"mutateActions"`
	AskActions          []string `json:"askActions"`
	DenyActions         []string `json:"denyActions"`
	SensitiveConfigKeys []string `json:"sensitiveConfigKeys"`
	DefaultAction       string   `json:"defaultAction"`
}

type cronPolicyJSON struct {
	AllowActions             []string `json:"allowActions"`
	MutateActions            []string `json:"mutateActions"`
	AskActions               []string `json:"askActions"`
	DenyActions              []string `json:"denyActions"`
	AutonomousPayloadKinds   []string `json:"autonomousPayloadKinds"`
	AutonomousSessionTargets []string `json:"autonomousSessionTargets"`
	ExternalWebhookModes     []string `json:"externalWebhookModes"`
	InternalURLMarkers       []string `json:"internalUrlMarkers"`
	SensitiveConfigKeys      []string `json:"sensitiveConfigKeys"`
	DefaultAction            string   `json:"defaultAction"`
}

type sessionsSpawnPolicy struct {
	AskRuntimes                 []string `json:"askRuntimes"`
	AskModes                    []string `json:"askModes"`
	AskWhenThreadRequested      *bool    `json:"askWhenThreadRequested"`
	AskWhenCrossAgent           *bool    `json:"askWhenCrossAgent"`
	AskWhenTargetWithoutCurrent *bool    `json:"askWhenTargetWithoutCurrent"`
}

type sessionsSendPolicy struct {
	AllowSameSession             *bool  `json:"allowSameSession"`
	AllowSameAgentWithoutSession *bool  `json:"allowSameAgentWithoutSession"`
	DefaultAction                string `json:"defaultAction"`
}

func allow(reason string) CheckResult {
	return CheckResult{Decision: DecisionAllow, Reason: reason, Source: "none", ParseKind: ParseSimple}
}

func ask(source, ruleID, reason string) CheckResult {
	return CheckResult{Decision: DecisionAsk, Reason: reason, Source: source, RuleID: ruleID, ParseKind: ParseSimple}
}

func deny(source, ruleID, reason string) CheckResult {
	return CheckResult{Decision: DecisionDeny, Reason: reason, Source: source, RuleID: ruleID, ParseKind: ParseSimple}
}
