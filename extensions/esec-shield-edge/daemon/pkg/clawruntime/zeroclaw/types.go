package zeroclaw

type HookContext struct {
	SessionKey string `json:"sessionKey,omitempty"`
	AgentID    string `json:"agentId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
}

type HookAgentContext struct {
	HookContext
	WorkspaceDir string `json:"workspaceDir,omitempty"`
	Trigger      string `json:"trigger,omitempty"`
	Channel      string `json:"channel,omitempty"`
}

type HookSessionContext struct {
	HookContext
	Channel string `json:"channel,omitempty"`
}

type HookGatewayContext struct{}

type HookToolContext struct {
	HookContext
	ToolName   string `json:"toolName"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

type HookLlmContext struct {
	HookContext
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
}

type HookGatewayStartEvent struct{}

type HookSessionStartEvent struct {
	SessionID  string `json:"sessionId"`
	SessionKey string `json:"sessionKey,omitempty"`
	Channel    string `json:"channel,omitempty"`
}

type HookSessionEndEvent struct {
	SessionID    string `json:"sessionId"`
	SessionKey   string `json:"sessionKey,omitempty"`
	Channel      string `json:"channel,omitempty"`
	MessageCount int    `json:"messageCount,omitempty"`
	DurationMs   int    `json:"durationMs,omitempty"`
}

type HookAgentEndEvent struct {
	SessionKey string `json:"sessionKey,omitempty"`
	Success    bool   `json:"success"`
	Error      string `json:"error,omitempty"`
	DurationMs int    `json:"durationMs,omitempty"`
}

type HookLlmInputEvent struct {
	SessionID string    `json:"sessionId,omitempty"`
	Provider  string    `json:"provider"`
	Model     string    `json:"model"`
	Messages  []any     `json:"messages,omitempty"`
	Usage     *LlmUsage `json:"usage,omitempty"`
}

type HookLlmOutputEvent struct {
	SessionID string    `json:"sessionId,omitempty"`
	Provider  string    `json:"provider"`
	Model     string    `json:"model"`
	Response  string    `json:"response,omitempty"`
	Usage     *LlmUsage `json:"usage,omitempty"`
}

type LlmUsage struct {
	Input      int `json:"input,omitempty"`
	Output     int `json:"output,omitempty"`
	CacheRead  int `json:"cacheRead,omitempty"`
	CacheWrite int `json:"cacheWrite,omitempty"`
	Total      int `json:"total,omitempty"`
}

type HookBeforePromptBuildEvent struct {
	Prompt     string `json:"prompt"`
	SessionKey string `json:"sessionKey,omitempty"`
}

type HookBeforeAgentReplyEvent struct {
	Content    string `json:"content"`
	SessionKey string `json:"sessionKey,omitempty"`
}

type HookBeforeToolCallEvent struct {
	ToolName   string `json:"toolName"`
	Params     any    `json:"params"`
	SessionKey string `json:"sessionKey,omitempty"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

type HookBeforePromptBuildResult struct {
	PrependContext string `json:"prependContext,omitempty"`
}

type HookBeforeToolCallResult struct {
	Block       bool   `json:"block,omitempty"`
	BlockReason string `json:"blockReason,omitempty"`
}
