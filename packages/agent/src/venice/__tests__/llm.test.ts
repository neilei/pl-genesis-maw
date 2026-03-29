/**
 * Unit tests for Venice LLM configuration — verifies model names,
 * venice_parameters (web search, web scraping, thinking), and tier separation.
 *
 * @module @maw/agent/venice/llm.test
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// Capture all ChatOpenAI constructor calls
const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock("@langchain/openai", () => {
  return {
    ChatOpenAI: class MockChatOpenAI {
      constructor(opts: Record<string, unknown>) {
        constructorCalls.push(opts);
      }
      invoke = vi.fn();
      withStructuredOutput = vi.fn();
    },
  };
});

vi.mock("../../config.js", () => ({
  env: {
    VENICE_API_KEY: "test-key",
    VENICE_BASE_URL: "https://api.venice.ai/api/v1",
    VENICE_MODEL_OVERRIDE: undefined,
  },
}));

vi.mock("../../logging/budget.js", () => ({
  updateBudget: vi.fn(),
}));

// Import triggers side-effect LLM creation
beforeAll(async () => {
  await import("../llm.js");
});

describe("Venice LLM configuration", () => {
  it("creates exactly 3 LLM instances (fast, research, reasoning)", () => {
    expect(constructorCalls).toHaveLength(3);
  });

  it("fast LLM uses qwen3-5-9b with web search disabled", () => {
    const fast = constructorCalls[0]!;
    expect(fast.model).toBe("qwen3-5-9b");
    expect(fast.temperature).toBe(0.3);

    const kwargs = fast.modelKwargs as { venice_parameters: Record<string, unknown> };
    expect(kwargs.venice_parameters.enable_web_search).toBe("off");
    expect(kwargs.venice_parameters.enable_web_scraping).toBe(false);
    expect(kwargs.venice_parameters.disable_thinking).toBe(true);
  });

  it("research LLM uses qwen3-5-9b with web search and scraping enabled", () => {
    const research = constructorCalls[1]!;
    expect(research.model).toBe("qwen3-5-9b");
    expect(research.temperature).toBe(0.5);

    const kwargs = research.modelKwargs as { venice_parameters: Record<string, unknown> };
    expect(kwargs.venice_parameters.enable_web_search).toBe("on");
    expect(kwargs.venice_parameters.enable_web_scraping).toBe(true);
    expect(kwargs.venice_parameters.enable_web_citations).toBe(true);
    expect(kwargs.venice_parameters.disable_thinking).toBe(false);
  });

  it("reasoning LLM uses qwen3-5-9b with web scraping disabled", () => {
    const reasoning = constructorCalls[2]!;
    expect(reasoning.model).toBe("qwen3-5-9b");
    expect(reasoning.temperature).toBe(0);

    const kwargs = reasoning.modelKwargs as { venice_parameters: Record<string, unknown> };
    expect(kwargs.venice_parameters.enable_web_search).toBe("off");
    expect(kwargs.venice_parameters.enable_web_scraping).toBe(false);
    expect(kwargs.venice_parameters.enable_web_citations).toBe(false);
    expect(kwargs.venice_parameters.disable_thinking).toBe(false);
  });

  it("all LLMs use Venice API base URL", () => {
    for (const call of constructorCalls) {
      const config = call.configuration as { baseURL: string };
      expect(config.baseURL).toBe("https://api.venice.ai/api/v1");
    }
  });

  it("all LLMs have custom fetch wrapper for budget tracking", () => {
    for (const call of constructorCalls) {
      const config = call.configuration as { fetch: unknown };
      expect(typeof config.fetch).toBe("function");
    }
  });

  it("research and reasoning use different venice_parameters (research has web features)", () => {
    const researchParams = (constructorCalls[1]!.modelKwargs as Record<string, unknown>).venice_parameters as Record<string, unknown>;
    const reasoningParams = (constructorCalls[2]!.modelKwargs as Record<string, unknown>).venice_parameters as Record<string, unknown>;
    expect(researchParams.enable_web_search).toBe("on");
    expect(reasoningParams.enable_web_search).toBe("off");
  });

  it("fast LLM has web scraping disabled (no hallucination risk for simple lookups)", () => {
    const fast = constructorCalls[0]!;
    const kwargs = fast.modelKwargs as { venice_parameters: Record<string, unknown> };
    expect(kwargs.venice_parameters.enable_web_scraping).toBe(false);
  });

  it("no LLM includes Venice system prompt", () => {
    for (const call of constructorCalls) {
      const kwargs = call.modelKwargs as { venice_parameters: Record<string, unknown> };
      expect(kwargs.venice_parameters.include_venice_system_prompt).toBe(false);
    }
  });

  it("research tier has prompt_cache_key set", () => {
    const research = constructorCalls[1]!;
    const kwargs = research.modelKwargs as { venice_parameters: Record<string, unknown> };
    expect(kwargs.venice_parameters.prompt_cache_key).toBe("maw-research");
  });

  it("reasoning tier has prompt_cache_key set", () => {
    const reasoning = constructorCalls[2]!;
    const kwargs = reasoning.modelKwargs as { venice_parameters: Record<string, unknown> };
    expect(kwargs.venice_parameters.prompt_cache_key).toBe("maw-reasoning");
  });
});
