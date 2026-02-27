"""Tests for bedrock router configuration and helpers."""

import json
import time
from unittest.mock import MagicMock, patch

import pytest


class TestBedrockClientConfig:
    """Verify the Bedrock runtime client is configured correctly."""

    def test_retry_config_max_attempts(self):
        """get_bedrock_client() should configure max_attempts=3."""
        # Reset global client so get_bedrock_client() re-creates it
        import main

        main._bedrock_client = None

        with patch("main.boto3") as mock_boto3:
            mock_client = MagicMock()
            mock_boto3.client.return_value = mock_client

            client = main.get_bedrock_client()

            # Verify boto3.client was called
            mock_boto3.client.assert_called_once()
            call_kwargs = mock_boto3.client.call_args

            # Extract the BotoConfig from the call
            config_arg = call_kwargs.kwargs.get("config") or call_kwargs[1].get(
                "config"
            )
            assert config_arg is not None, "BotoConfig not passed to boto3.client"

            # BotoConfig stores retries in _user_provided_options
            retries = config_arg.retries
            assert retries is not None, "retries not configured"
            assert retries.get("max_attempts") == 3, (
                f"Expected max_attempts=3, got {retries}"
            )

        # Clean up
        main._bedrock_client = None

    def test_read_timeout(self):
        """get_bedrock_client() should configure read_timeout=900."""
        import main

        main._bedrock_client = None

        with patch("main.boto3") as mock_boto3:
            mock_boto3.client.return_value = MagicMock()
            main.get_bedrock_client()

            config_arg = mock_boto3.client.call_args.kwargs.get(
                "config"
            ) or mock_boto3.client.call_args[1].get("config")
            assert config_arg.read_timeout == 900

        main._bedrock_client = None

    def test_connect_timeout(self):
        """get_bedrock_client() should configure connect_timeout=10."""
        import main

        main._bedrock_client = None

        with patch("main.boto3") as mock_boto3:
            mock_boto3.client.return_value = MagicMock()
            main.get_bedrock_client()

            config_arg = mock_boto3.client.call_args.kwargs.get(
                "config"
            ) or mock_boto3.client.call_args[1].get("config")
            assert config_arg.connect_timeout == 10

        main._bedrock_client = None


class TestModelMapping:
    """Verify model mapping configuration."""

    def test_default_model_map_contains_expected_models(self):
        import main

        model_map = main.DEFAULT_MODEL_MAP
        assert "claude-opus" in model_map
        assert "claude-sonnet" in model_map
        # Verify new Mantle models are in the map
        assert "deepseek-v3" in model_map
        assert model_map["deepseek-v3"] == "deepseek.v3.2"
        assert "minimax-m2" in model_map
        assert model_map["minimax-m2"] == "minimax.minimax-m2.1"
        assert "glm-4" in model_map
        assert model_map["glm-4"] == "zai.glm-4.7"
        assert "glm-4-flash" in model_map
        assert model_map["glm-4-flash"] == "zai.glm-4.7-flash"
        assert "qwen3-coder" in model_map
        assert model_map["qwen3-coder"] == "qwen.qwen3-coder-next"
        # Verify bedrock/ prefixed variants exist
        assert "bedrock/deepseek-v3" in model_map
        assert "bedrock/minimax-m2" in model_map
        assert "bedrock/glm-4" in model_map
        assert "bedrock/glm-4-flash" in model_map
        assert "bedrock/qwen3-coder" in model_map

    def test_is_anthropic_model(self):
        import main

        assert main.is_anthropic_model("us.anthropic.claude-opus-4-6-v1") is True
        assert main.is_anthropic_model("anthropic.claude-v2") is True
        assert main.is_anthropic_model("moonshotai.kimi-k2.5") is False
        assert main.is_anthropic_model("meta.llama-3") is False
        # New Mantle models should NOT be Anthropic
        assert main.is_anthropic_model("deepseek.v3.2") is False
        assert main.is_anthropic_model("minimax.minimax-m2.1") is False
        assert main.is_anthropic_model("zai.glm-4.7") is False
        assert main.is_anthropic_model("zai.glm-4.7-flash") is False
        assert main.is_anthropic_model("qwen.qwen3-coder-next") is False


class TestStopReasonMapping:
    """Verify Converse stopReason -> OpenAI finish_reason mapping."""

    def test_stop_reason_mappings(self):
        import main

        assert main._map_stop_reason("end_turn") == "stop"
        assert main._map_stop_reason("stop_sequence") == "stop"
        assert main._map_stop_reason("tool_use") == "tool_calls"
        assert main._map_stop_reason("max_tokens") == "length"
        assert main._map_stop_reason("content_filtered") == "content_filter"
        assert main._map_stop_reason("unknown_reason") == "stop"  # default


class TestSSEChunk:
    """Verify _make_sse_chunk builds correct OpenAI-compatible chunks."""

    def test_basic_chunk_without_usage(self):
        """_make_sse_chunk without usage should not include usage field."""
        import main

        chunk = main._make_sse_chunk("req-1", "test-model", delta={"content": "hello"})
        assert chunk["id"] == "chatcmpl-req-1"
        assert chunk["object"] == "chat.completion.chunk"
        assert chunk["model"] == "test-model"
        assert chunk["choices"][0]["delta"] == {"content": "hello"}
        assert "usage" not in chunk

    def test_chunk_with_finish_reason(self):
        """_make_sse_chunk with finish_reason should include it in the choice."""
        import main

        chunk = main._make_sse_chunk(
            "req-2", "test-model", delta={}, finish_reason="stop"
        )
        assert chunk["choices"][0]["finish_reason"] == "stop"
        assert "usage" not in chunk

    def test_chunk_with_usage(self):
        """_make_sse_chunk with usage should include usage at top level."""
        import main

        usage = {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "total_tokens": 150,
        }
        chunk = main._make_sse_chunk("req-3", "test-model", delta={}, usage=usage)
        assert "usage" in chunk
        assert chunk["usage"]["prompt_tokens"] == 100
        assert chunk["usage"]["completion_tokens"] == 50
        assert chunk["usage"]["total_tokens"] == 150

    def test_chunk_with_usage_none_omits_field(self):
        """_make_sse_chunk with usage=None should not include usage field."""
        import main

        chunk = main._make_sse_chunk("req-4", "test-model", delta={}, usage=None)
        assert "usage" not in chunk


class TestConverseResponseTranslation:
    """Verify translate_converse_to_openai extracts usage correctly."""

    def test_usage_extraction_from_converse_response(self):
        """translate_converse_to_openai should map inputTokens/outputTokens."""
        import main

        converse_response = {
            "output": {
                "message": {
                    "content": [{"text": "Hello there"}],
                    "role": "assistant",
                }
            },
            "usage": {
                "inputTokens": 42,
                "outputTokens": 17,
            },
            "stopReason": "end_turn",
        }
        result = main.translate_converse_to_openai(
            converse_response, "test-model", "req-5"
        )
        assert result["usage"]["prompt_tokens"] == 42
        assert result["usage"]["completion_tokens"] == 17
        assert result["usage"]["total_tokens"] == 59

    def test_usage_defaults_to_zero_when_missing(self):
        """translate_converse_to_openai should default to 0 when usage is empty."""
        import main

        converse_response = {
            "output": {
                "message": {
                    "content": [{"text": "Hi"}],
                    "role": "assistant",
                }
            },
            "usage": {},
            "stopReason": "end_turn",
        }
        result = main.translate_converse_to_openai(
            converse_response, "test-model", "req-6"
        )
        assert result["usage"]["prompt_tokens"] == 0
        assert result["usage"]["completion_tokens"] == 0
        assert result["usage"]["total_tokens"] == 0


class TestPromptCaching:
    """Verify prompt caching cachePoint injection and cache usage metrics."""

    def test_system_blocks_get_cache_point_when_enabled(self):
        """translate_openai_to_converse should append cachePoint to system blocks."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello"},
            ],
        }
        params = main.translate_openai_to_converse(body, enable_cache=True)
        system = params["system"]
        assert system[-1] == {"cachePoint": {"type": "default"}}
        assert system[0] == {"text": "You are a helpful assistant."}

    def test_system_blocks_no_cache_point_when_disabled(self):
        """translate_openai_to_converse should NOT add cachePoint when disabled."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello"},
            ],
        }
        params = main.translate_openai_to_converse(body, enable_cache=False)
        system = params["system"]
        assert len(system) == 1
        assert system[0] == {"text": "You are a helpful assistant."}

    def test_tools_get_cache_point_when_enabled(self):
        """translate_openai_to_converse should append cachePoint to tools list."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hello"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get the weather",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        }
        params = main.translate_openai_to_converse(body, enable_cache=True)
        tools = params["toolConfig"]["tools"]
        assert tools[-1] == {"cachePoint": {"type": "default"}}
        assert "toolSpec" in tools[0]

    def test_tools_no_cache_point_when_disabled(self):
        """translate_openai_to_converse should NOT add cachePoint to tools when disabled."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hello"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get the weather",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        }
        params = main.translate_openai_to_converse(body, enable_cache=False)
        tools = params["toolConfig"]["tools"]
        assert len(tools) == 1
        assert "toolSpec" in tools[0]

    def test_synthesized_tools_get_cache_point_when_enabled(self):
        """Synthesized toolConfig from history should also get cachePoint."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": "{}",
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": "sunny",
                },
                {"role": "user", "content": "Thanks"},
            ],
        }
        params = main.translate_openai_to_converse(body, enable_cache=True)
        tools = params["toolConfig"]["tools"]
        assert tools[-1] == {"cachePoint": {"type": "default"}}

    def test_cache_control_passthrough_in_content(self):
        """Client cache_control hints should be translated to cachePoint blocks."""
        import main

        content = [
            {
                "type": "text",
                "text": "Long context here...",
                "cache_control": {"type": "ephemeral"},
            },
            {"type": "text", "text": "Question?"},
        ]
        blocks = main._translate_content(content)
        # Should be: text, cachePoint, text
        assert len(blocks) == 3
        assert blocks[0] == {"text": "Long context here..."}
        assert blocks[1] == {"cachePoint": {"type": "default"}}
        assert blocks[2] == {"text": "Question?"}

    def test_no_cache_control_no_extra_blocks(self):
        """Without cache_control, no cachePoint blocks should be injected in content."""
        import main

        content = [
            {"type": "text", "text": "Hello"},
            {"type": "text", "text": "World"},
        ]
        blocks = main._translate_content(content)
        assert len(blocks) == 2
        assert blocks[0] == {"text": "Hello"}
        assert blocks[1] == {"text": "World"}


class TestBuildUsage:
    """Verify _build_usage extracts cache metrics correctly."""

    def test_build_usage_with_cache_metrics(self):
        """_build_usage should include cache fields when present."""
        import main

        usage = {
            "inputTokens": 100,
            "outputTokens": 50,
            "cacheReadInputTokens": 80,
            "cacheWriteInputTokens": 20,
        }
        result = main._build_usage(usage)
        assert result["prompt_tokens"] == 100
        assert result["completion_tokens"] == 50
        assert result["total_tokens"] == 150
        assert result["cache_read_input_tokens"] == 80
        assert result["cache_creation_input_tokens"] == 20
        assert result["prompt_tokens_details"]["cached_tokens"] == 80

    def test_build_usage_without_cache_metrics(self):
        """_build_usage should omit cache fields when not present."""
        import main

        usage = {
            "inputTokens": 42,
            "outputTokens": 17,
        }
        result = main._build_usage(usage)
        assert result["prompt_tokens"] == 42
        assert result["completion_tokens"] == 17
        assert result["total_tokens"] == 59
        assert "cache_read_input_tokens" not in result
        assert "cache_creation_input_tokens" not in result
        assert "prompt_tokens_details" not in result

    def test_build_usage_zero_cache_omits_fields(self):
        """_build_usage with zero cache values should omit cache fields."""
        import main

        usage = {
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadInputTokens": 0,
            "cacheWriteInputTokens": 0,
        }
        result = main._build_usage(usage)
        assert "cache_read_input_tokens" not in result
        assert "prompt_tokens_details" not in result

    def test_converse_response_with_cache_usage(self):
        """translate_converse_to_openai should surface cache metrics in usage."""
        import main

        converse_response = {
            "output": {
                "message": {
                    "content": [{"text": "Hello"}],
                    "role": "assistant",
                }
            },
            "usage": {
                "inputTokens": 100,
                "outputTokens": 20,
                "cacheReadInputTokens": 80,
                "cacheWriteInputTokens": 0,
            },
            "stopReason": "end_turn",
        }
        result = main.translate_converse_to_openai(
            converse_response, "test-model", "req-cache"
        )
        assert result["usage"]["cache_read_input_tokens"] == 80
        assert result["usage"]["prompt_tokens_details"]["cached_tokens"] == 80
