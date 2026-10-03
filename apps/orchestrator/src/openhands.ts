import { setTimeout as delay } from "node:timers/promises";

export type OpenHandsConfig = {
  apiKey?: string;
  model: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
};

export type OpenHandsRun = {
  conversationId: string;
  finalResponse: string;
  accumulatedCost: number;
};

export class OpenHandsClient {
  constructor(private readonly config: OpenHandsConfig) {}

  async run(baseUrl: string, workingDirectory: string, prompt: string): Promise<OpenHandsRun> {
    if (!this.config.llmApiKey) throw new Error("OPENHANDS_LLM_API_KEY is not configured");
    const llm: Record<string, string> = {
      model: this.config.model,
      api_key: this.config.llmApiKey,
    };
    if (this.config.llmBaseUrl) llm.base_url = this.config.llmBaseUrl;
    const response = await this.request(baseUrl, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        agent: {
          kind: "Agent",
          llm,
          tools: [
            { name: "TerminalTool" },
            { name: "FileEditorTool" },
            { name: "TaskTrackerTool" },
          ],
        },
        workspace: { working_dir: workingDirectory },
        initial_message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
          run: true,
        },
      }),
    });
    if (response.status !== 201) {
      throw new Error(`OpenHands conversation creation failed (${response.status}): ${await response.text()}`);
    }
    const created = await response.json() as { id: string };
    const terminal = new Set(["finished", "error", "stuck", "stopped", "paused"]);
    const started = Date.now();
    let data: Record<string, unknown> = {};
    while (Date.now() - started < 45 * 60_000) {
      const statusResponse = await this.request(baseUrl, `/api/conversations/${created.id}`);
      if (!statusResponse.ok) throw new Error(`OpenHands status failed (${statusResponse.status})`);
      data = await statusResponse.json() as Record<string, unknown>;
      const executionStatus = String(data.execution_status ?? "unknown");
      if (terminal.has(executionStatus)) {
        if (executionStatus !== "finished" && executionStatus !== "stopped") {
          throw new Error(`OpenHands ended with status ${executionStatus}`);
        }
        break;
      }
      await delay(2_000);
    }
    if (Date.now() - started >= 45 * 60_000) throw new Error("OpenHands run timed out");
    const final = await this.request(baseUrl, `/api/conversations/${created.id}/agent_final_response`);
    const finalData = final.ok ? await final.json() as { response?: string } : {};
    return {
      conversationId: created.id,
      finalResponse: finalData.response ?? "",
      accumulatedCost: accumulatedCost(data),
    };
  }

  private request(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.config.apiKey) headers.set("authorization", `Bearer ${this.config.apiKey}`);
    return fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init, headers, signal: AbortSignal.timeout(120_000),
    });
  }
}

function accumulatedCost(conversation: Record<string, unknown>): number {
  const stats = conversation.stats;
  if (!stats || typeof stats !== "object") return 0;
  const metrics = (stats as Record<string, unknown>).usage_to_metrics;
  if (!metrics || typeof metrics !== "object") return 0;
  return Object.values(metrics).reduce((sum, value) => {
    if (!value || typeof value !== "object") return sum;
    const cost = (value as Record<string, unknown>).accumulated_cost;
    return sum + (typeof cost === "number" ? cost : 0);
  }, 0);
}
