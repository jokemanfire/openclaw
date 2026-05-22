package openclaw

type HookContext struct {
	SessionKey string `json:"sessionKey,omitempty"`
	AgentID    string `json:"agentId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	RunID      string `json:"runId,omitempty"`
}

type HookAgentContext struct {
	HookContext
	WorkspaceDir    string `json:"workspaceDir,omitempty"`
	MessageProvider string `json:"messageProvider,omitempty"`
	Trigger         string `json:"trigger,omitempty"`
	ChannelID       string `json:"channelId,omitempty"`
}

type HookSessionContext struct {
	HookContext
}

type HookGatewayContext struct {
	Port int `json:"port,omitempty"`
}

type HookToolContext struct {
	HookContext
	ToolName   string `json:"toolName"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

type HookMessageContext struct {
	ChannelID      string `json:"channelId,omitempty"`
	AccountID      string `json:"accountId,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	SessionKey     string `json:"sessionKey,omitempty"`
	RunID          string `json:"runId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	SenderID       string `json:"senderId,omitempty"`
}

type HookGatewayStartEvent struct {
	Port int `json:"port"`
}

type HookSessionStartEvent struct {
	SessionID   string `json:"sessionId"`
	SessionKey  string `json:"sessionKey,omitempty"`
	ResumedFrom string `json:"resumedFrom,omitempty"`
}

type HookSessionEndEvent struct {
	SessionID    string `json:"sessionId"`
	SessionKey   string `json:"sessionKey,omitempty"`
	MessageCount int    `json:"messageCount"`
	DurationMs   int    `json:"durationMs,omitempty"`
}

type HookAgentEndEvent struct {
	Messages   []any  `json:"messages"`
	Success    bool   `json:"success"`
	Error      string `json:"error,omitempty"`
	DurationMs int    `json:"durationMs,omitempty"`
}

type HookLlmInputEvent struct {
	RunID           string `json:"runId"`
	SessionID       string `json:"sessionId"`
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	SystemPrompt    string `json:"systemPrompt,omitempty"`
	Prompt          string `json:"prompt"`
	HistoryMessages []any  `json:"historyMessages"`
	ImagesCount     int    `json:"imagesCount"`
}

type HookLlmOutputEvent struct {
	RunID          string   `json:"runId"`
	SessionID      string   `json:"sessionId"`
	Provider       string   `json:"provider"`
	Model          string   `json:"model"`
	AssistantTexts []string `json:"assistantTexts"`
	LastAssistant  any      `json:"lastAssistant,omitempty"`
	Usage          *Usage   `json:"usage,omitempty"`
}

type Usage struct {
	Input      int `json:"input,omitempty"`
	Output     int `json:"output,omitempty"`
	CacheRead  int `json:"cacheRead,omitempty"`
	CacheWrite int `json:"cacheWrite,omitempty"`
	Total      int `json:"total,omitempty"`
}

type HookBeforePromptBuildEvent struct {
	Prompt   string `json:"prompt"`
	Messages []any  `json:"messages"`
}

type HookBeforeAgentReplyEvent struct {
	CleanedBody string `json:"cleanedBody"`
}

type HookBeforeToolCallEvent struct {
	ToolName   string `json:"toolName"`
	Params     any    `json:"params"`
	RunID      string `json:"runId,omitempty"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

type HookBeforeAgentReplyResult struct {
	Handled bool   `json:"handled"`
	Reply   any    `json:"reply,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type HookBeforePromptBuildResult struct {
	SystemPrompt         string `json:"systemPrompt,omitempty"`
	PrependContext       string `json:"prependContext,omitempty"`
	PrependSystemContext string `json:"prependSystemContext,omitempty"`
	AppendSystemContext  string `json:"appendSystemContext,omitempty"`
}

type HookBeforeToolCallResult struct {
	Params          any          `json:"params,omitempty"`
	Block           bool         `json:"block,omitempty"`
	BlockReason     string       `json:"blockReason,omitempty"`
	RequireApproval *ApprovalReq `json:"requireApproval,omitempty"`
}

type ApprovalReq struct {
	Title           string `json:"title"`
	Description     string `json:"description"`
	Severity        string `json:"severity,omitempty"`
	TimeoutMs       int    `json:"timeoutMs,omitempty"`
	TimeoutBehavior string `json:"timeoutBehavior,omitempty"`
	PluginID        string `json:"pluginId,omitempty"`
}

type HookMessageSendingEvent struct {
	To        string         `json:"to"`
	Content   string         `json:"content"`
	ReplyToID string         `json:"replyToId,omitempty"`
	ThreadID  string         `json:"threadId,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type HookMessageSendingResult struct {
	Content string `json:"content,omitempty"`
	Cancel  bool   `json:"cancel,omitempty"`
}
