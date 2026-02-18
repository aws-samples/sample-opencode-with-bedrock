#!/usr/bin/env python3
"""Bedrock Router Service — ECS-ready proxy with dual backend (Mantle + Converse API)."""

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import signal
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import aiohttp
import boto3
from aiohttp import web
from aws_bedrock_token_generator import provide_token
from botocore.config import Config as BotoConfig


# Structured JSON logging for CloudWatch
_DEFAULT_LOG_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


class JSONFormatter(logging.Formatter):
    def format(self, record):
        log_data = {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Capture all extra fields passed via extra={...}
        for key, value in record.__dict__.items():
            if key not in _DEFAULT_LOG_ATTRS and key not in log_data:
                log_data[key] = value
        # Include stack trace if present (from log.exception())
        if record.exc_info and record.exc_info[0] is not None:
            log_data["traceback"] = self.formatException(record.exc_info)
        return json.dumps(log_data, default=str)


# Setup logging
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JSONFormatter())
log = logging.getLogger("bedrock-router")
log.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
log.handlers = [handler]

MANTLE_URL = os.environ.get(
    "BEDROCK_MANTLE_URL", "https://bedrock-mantle.us-east-1.api.aws"
)
SERVICE_VERSION = os.environ.get("SERVICE_VERSION", "1.0.0")

# Model mapping — override via BEDROCK_MODEL_MAP env var (JSON string)
DEFAULT_MODEL_MAP = {
    "kimi-k25": "moonshotai.kimi-k2.5",
    "bedrock/kimi-k25": "moonshotai.kimi-k2.5",
    "bedrock/kimi-k2-thinking": "moonshotai.kimi-k2-thinking",
    "claude-opus": "us.anthropic.claude-opus-4-6-v1",
    "bedrock/claude-opus": "us.anthropic.claude-opus-4-6-v1",
    "claude-sonnet": "us.anthropic.claude-sonnet-4-6-v1",
    "bedrock/claude-sonnet": "us.anthropic.claude-sonnet-4-6-v1",
    "claude-sonnet-45": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "bedrock/claude-sonnet-45": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
}

_model_map = None


def get_model_map():
    global _model_map
    if _model_map is None:
        override = os.environ.get("BEDROCK_MODEL_MAP")
        _model_map = json.loads(override) if override else DEFAULT_MODEL_MAP
    return _model_map


# Token cache — provide_token() uses IAM role via SigV4
_token = {"value": None, "expires": 0}
TOKEN_TTL = 3600  # 1 hour refresh


def get_token():
    now = time.time()
    if _token["value"] and now < _token["expires"]:
        return _token["value"]
    tok = provide_token()
    _token["value"] = tok
    _token["expires"] = now + TOKEN_TTL
    log.info("Refreshed Bedrock token", extra={"ttl_seconds": TOKEN_TTL})
    return tok


# ---------------------------------------------------------------------------
# Anthropic / Bedrock Converse API support
# ---------------------------------------------------------------------------

_bedrock_client = None
_executor = ThreadPoolExecutor(max_workers=4)


def is_anthropic_model(model_id):
    """Check if a resolved model ID targets an Anthropic model."""
    return model_id.startswith("anthropic.") or model_id.startswith("us.anthropic.")


def get_bedrock_client():
    """Lazy-init a boto3 bedrock-runtime client with extended read timeout."""
    global _bedrock_client
    if _bedrock_client is None:
        region = os.environ.get("AWS_REGION", "us-east-1")
        _bedrock_client = boto3.client(
            "bedrock-runtime",
            region_name=region,
            config=BotoConfig(
                read_timeout=900,
                connect_timeout=10,
                retries={"max_attempts": 3},
            ),
        )
        log.info("Initialized Bedrock runtime client", extra={"region": region})
    return _bedrock_client


def translate_openai_to_converse(body):
    """Convert an OpenAI chat-completion request body to Bedrock Converse API params."""
    messages = body.get("messages", [])

    # Separate system messages
    system_blocks = []
    converse_messages = []

    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "system":
            if isinstance(content, str):
                system_blocks.append({"text": content})
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, str):
                        system_blocks.append({"text": part})
                    elif isinstance(part, dict) and part.get("type") == "text":
                        system_blocks.append({"text": part["text"]})
            continue

        if role == "tool":
            # Tool results map to user role with toolResult content block.
            # Multiple consecutive tool messages must merge into ONE user
            # message — Converse API requires strictly alternating roles.
            tool_call_id = msg.get("tool_call_id", "")
            result_content = content if isinstance(content, str) else json.dumps(content)
            tool_result_block = {
                "toolResult": {
                    "toolUseId": tool_call_id,
                    "content": [{"text": result_content}],
                }
            }
            if converse_messages and converse_messages[-1]["role"] == "user":
                converse_messages[-1]["content"].append(tool_result_block)
            else:
                converse_messages.append({
                    "role": "user",
                    "content": [tool_result_block],
                })
            continue

        # Convert content to Converse format
        converse_content = _translate_content(content)

        # Handle assistant messages with tool_calls
        if role == "assistant" and "tool_calls" in msg:
            # Strip empty text blocks — Converse rejects blank text
            # alongside toolUse blocks.
            converse_content = [
                b for b in converse_content
                if not ("text" in b and not b["text"])
            ]
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                args_str = fn.get("arguments", "{}")
                try:
                    args_json = json.loads(args_str)
                except (json.JSONDecodeError, TypeError):
                    args_json = {"raw": args_str}
                converse_content.append({
                    "toolUse": {
                        "toolUseId": tc.get("id", ""),
                        "name": fn.get("name", ""),
                        "input": args_json,
                    }
                })

        converse_messages.append({"role": role, "content": converse_content})

    # Build params
    params = {
        "modelId": body["model"],
        "messages": converse_messages,
    }

    if system_blocks:
        params["system"] = system_blocks

    # Inference config
    inference_config = {}
    if "max_tokens" in body:
        inference_config["maxTokens"] = body["max_tokens"]
    if "temperature" in body:
        inference_config["temperature"] = body["temperature"]
    if "top_p" in body:
        inference_config["topP"] = body["top_p"]
    if "stop" in body:
        stop = body["stop"]
        if isinstance(stop, str):
            stop = [stop]
        inference_config["stopSequences"] = stop
    if inference_config:
        params["inferenceConfig"] = inference_config

    # Tool config
    if "tools" in body:
        tools = []
        for tool in body["tools"]:
            if tool.get("type") == "function":
                fn = tool["function"]
                tool_spec = {
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "inputSchema": {"json": fn.get("parameters", {})},
                }
                tools.append({"toolSpec": tool_spec})
        if tools:
            params["toolConfig"] = {"tools": tools}

    # Converse API requires toolConfig whenever toolUse/toolResult blocks
    # appear in the message history, even if the current request doesn't
    # include a tools array.  Synthesize a minimal config from the history.
    if "toolConfig" not in params:
        seen_tool_names = set()
        for cm in converse_messages:
            for block in cm.get("content", []):
                if "toolUse" in block:
                    seen_tool_names.add(block["toolUse"].get("name", ""))
                if "toolResult" in block:
                    seen_tool_names.discard("")  # just in case
        if seen_tool_names:
            params["toolConfig"] = {
                "tools": [
                    {
                        "toolSpec": {
                            "name": name,
                            "description": "Tool from conversation history",
                            "inputSchema": {"json": {"type": "object"}},
                        }
                    }
                    for name in sorted(seen_tool_names)
                    if name
                ]
            }

    # Extended thinking / reasoning via additionalModelRequestFields
    additional_fields = {}
    # Check for reasoning/thinking configuration
    if body.get("reasoning_effort") or body.get("thinking"):
        thinking_config = body.get("thinking", {})
        budget = thinking_config.get("budget_tokens", 10000)
        additional_fields["thinking"] = {
            "type": "enabled",
            "budget_tokens": budget,
        }

    if additional_fields:
        params["additionalModelRequestFields"] = additional_fields

    return params


def _translate_content(content):
    """Convert OpenAI message content to Converse content blocks."""
    if isinstance(content, str):
        return [{"text": content}] if content else [{"text": ""}]

    if isinstance(content, list):
        blocks = []
        for part in content:
            if isinstance(part, str):
                blocks.append({"text": part})
            elif isinstance(part, dict):
                part_type = part.get("type", "")
                if part_type == "text":
                    blocks.append({"text": part["text"]})
                elif part_type == "image_url":
                    url_data = part.get("image_url", {}).get("url", "")
                    if url_data.startswith("data:"):
                        # data:image/png;base64,<data>
                        header, b64data = url_data.split(",", 1)
                        media_type = header.split(":")[1].split(";")[0]
                        # Map MIME to Converse format name
                        fmt = media_type.split("/")[-1]
                        if fmt == "jpg":
                            fmt = "jpeg"
                        blocks.append({
                            "image": {
                                "format": fmt,
                                "source": {"bytes": base64.b64decode(b64data)},
                            }
                        })
                    else:
                        # URL reference — pass as text since Converse doesn't fetch URLs
                        blocks.append({"text": f"[Image URL: {url_data}]"})
        return blocks if blocks else [{"text": ""}]

    return [{"text": str(content)}] if content else [{"text": ""}]


def translate_converse_to_openai(response, model, request_id):
    """Convert a Bedrock Converse response to OpenAI chat-completion format."""
    output = response.get("output", {})
    message = output.get("message", {})
    content_blocks = message.get("content", [])
    usage = response.get("usage", {})
    stop_reason = response.get("stopReason", "end_turn")

    text_parts = []
    reasoning_parts = []
    tool_calls = []
    tool_idx = 0

    for block in content_blocks:
        if "text" in block:
            text_parts.append(block["text"])
        elif "reasoningContent" in block:
            rc = block["reasoningContent"]
            if "reasoningText" in rc:
                reasoning_parts.append(rc["reasoningText"]["text"])
        elif "toolUse" in block:
            tu = block["toolUse"]
            tool_calls.append({
                "index": tool_idx,
                "id": tu.get("toolUseId", f"call_{tool_idx}"),
                "type": "function",
                "function": {
                    "name": tu.get("name", ""),
                    "arguments": json.dumps(tu.get("input", {})),
                },
            })
            tool_idx += 1

    finish_reason = _map_stop_reason(stop_reason)

    result_message = {
        "role": "assistant",
        "content": "\n".join(text_parts) if text_parts else None,
    }
    if reasoning_parts:
        result_message["reasoning_content"] = "\n".join(reasoning_parts)
    if tool_calls:
        result_message["tool_calls"] = tool_calls
        if finish_reason == "stop":
            finish_reason = "tool_calls"

    return {
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": result_message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": usage.get("inputTokens", 0),
            "completion_tokens": usage.get("outputTokens", 0),
            "total_tokens": usage.get("inputTokens", 0)
            + usage.get("outputTokens", 0),
        },
    }


def _map_stop_reason(stop_reason):
    """Map Converse stopReason to OpenAI finish_reason."""
    mapping = {
        "end_turn": "stop",
        "stop_sequence": "stop",
        "tool_use": "tool_calls",
        "max_tokens": "length",
        "content_filtered": "content_filter",
    }
    return mapping.get(stop_reason, "stop")


async def handle_anthropic_non_streaming(body, request_id):
    """Call Converse API (non-streaming) in an executor thread."""
    loop = asyncio.get_event_loop()
    model = body["model"]
    params = translate_openai_to_converse(body)

    log.info(
        "Calling Converse API",
        extra={"request_id": request_id, "model": model},
    )

    try:
        client = get_bedrock_client()
        response = await loop.run_in_executor(
            _executor, lambda: client.converse(**params)
        )
        result = translate_converse_to_openai(response, model, request_id)
        return web.json_response(result, headers={"X-Request-ID": request_id})
    except Exception as e:
        error_name = type(e).__name__
        log.exception(
            "Converse API call failed",
            extra={"request_id": request_id, "error": str(e), "type": error_name},
        )
        return web.json_response(
            {
                "error": {
                    "message": "An internal error occurred while processing the request.",
                    "type": "server_error",
                    "code": "bedrock_error",
                }
            },
            status=502,
            headers={"X-Request-ID": request_id},
        )


async def handle_anthropic_streaming(body, request_id, request):
    """Call ConverseStream API, translate events to OpenAI SSE format."""
    model = body["model"]
    params = translate_openai_to_converse(body)

    log.info(
        "Calling ConverseStream API",
        extra={"request_id": request_id, "model": model},
    )

    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Request-ID": request_id,
        },
    )
    await response.prepare(request)

    try:
        loop = asyncio.get_event_loop()
        client = get_bedrock_client()
        stream_response = await loop.run_in_executor(
            _executor, lambda: client.converse_stream(**params)
        )
        stream = stream_response.get("stream")
        if not stream:
            await _write_sse(response, "[DONE]")
            await response.write_eof()
            return response

        tool_idx = -1

        async for event in _iter_stream_events(stream):
            if "messageStart" in event:
                chunk = _make_sse_chunk(
                    request_id,
                    model,
                    delta={"role": "assistant", "content": ""},
                )
                await _write_sse(response, json.dumps(chunk))

            elif "contentBlockStart" in event:
                start = event["contentBlockStart"].get("start", {})
                if "toolUse" in start:
                    tool_idx += 1
                    tu = start["toolUse"]
                    chunk = _make_sse_chunk(
                        request_id,
                        model,
                        delta={
                            "tool_calls": [
                                {
                                    "index": tool_idx,
                                    "id": tu.get("toolUseId", ""),
                                    "type": "function",
                                    "function": {"name": tu.get("name", ""), "arguments": ""},
                                }
                            ]
                        },
                    )
                    await _write_sse(response, json.dumps(chunk))

            elif "contentBlockDelta" in event:
                delta_block = event["contentBlockDelta"].get("delta", {})

                if "text" in delta_block:
                    chunk = _make_sse_chunk(
                        request_id,
                        model,
                        delta={"content": delta_block["text"]},
                    )
                    await _write_sse(response, json.dumps(chunk))

                elif "reasoningContent" in delta_block:
                    rc = delta_block["reasoningContent"]
                    text = rc.get("text", "")
                    if text:
                        chunk = _make_sse_chunk(
                            request_id,
                            model,
                            delta={"reasoning_content": text},
                        )
                        await _write_sse(response, json.dumps(chunk))

                elif "toolUse" in delta_block:
                    input_str = delta_block["toolUse"].get("input", "")
                    if input_str:
                        chunk = _make_sse_chunk(
                            request_id,
                            model,
                            delta={
                                "tool_calls": [
                                    {
                                        "index": tool_idx,
                                        "function": {"arguments": input_str},
                                    }
                                ]
                            },
                        )
                        await _write_sse(response, json.dumps(chunk))

            elif "messageStop" in event:
                stop_reason = event["messageStop"].get("stopReason", "end_turn")
                finish = _map_stop_reason(stop_reason)
                chunk = _make_sse_chunk(
                    request_id, model, delta={}, finish_reason=finish
                )
                await _write_sse(response, json.dumps(chunk))

            elif "metadata" in event:
                # Stream complete — metadata contains usage info
                pass

        await _write_sse(response, "[DONE]")
        await response.write_eof()
        return response

    except Exception as e:
        error_name = type(e).__name__
        log.exception(
            "ConverseStream failed",
            extra={"request_id": request_id, "error": str(e), "type": error_name},
        )
        # Try to send error as SSE if stream is already started
        try:
            error_chunk = {
                "error": {
                    "message": "An internal error occurred while processing the stream.",
                    "type": "server_error",
                    "code": "bedrock_error",
                }
            }
            await _write_sse(response, json.dumps(error_chunk))
            await _write_sse(response, "[DONE]")
            await response.write_eof()
        except Exception:
            pass
        return response


async def _iter_stream_events(stream):
    """Async generator wrapping boto3's synchronous EventStream iterator."""
    loop = asyncio.get_event_loop()
    iterator = iter(stream)
    while True:
        try:
            event = await loop.run_in_executor(
                _executor, lambda: next(iterator, None)
            )
            if event is None:
                break
            yield event
        except StopIteration:
            break


async def _write_sse(response, data):
    """Write a single SSE frame."""
    await response.write(f"data: {data}\n\n".encode("utf-8"))


def _make_sse_chunk(request_id, model, delta, finish_reason=None):
    """Build an OpenAI-compatible streaming chunk."""
    choice = {"index": 0, "delta": delta}
    if finish_reason:
        choice["finish_reason"] = finish_reason
    return {
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [choice],
    }


# ---------------------------------------------------------------------------
# API Key Authentication
# ---------------------------------------------------------------------------

API_KEY_PREFIX = "oc_"
MAX_KEYS_PER_USER = 10
DEFAULT_EXPIRY_DAYS = 90
MIN_EXPIRY_DAYS = 1
MAX_EXPIRY_DAYS = 365
API_KEYS_TABLE_NAME = os.environ.get("API_KEYS_TABLE_NAME", "")

_dynamodb_table = None


def hash_api_key(key):
    """SHA-256 hash of an API key (hex digest)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def generate_api_key():
    """Generate a new API key: oc_<43-char base64url random>."""
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def decode_jwt_payload(token):
    """Decode JWT payload without signature verification (ALB already validated)."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    # Add padding
    padding = 4 - len(payload) % 4
    if padding != 4:
        payload += "=" * padding
    try:
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return None


def get_dynamodb_table():
    """Lazy-init a DynamoDB Table resource."""
    global _dynamodb_table
    if _dynamodb_table is None:
        if not API_KEYS_TABLE_NAME:
            raise RuntimeError("API_KEYS_TABLE_NAME not configured")
        region = os.environ.get("AWS_REGION", "us-east-1")
        dynamodb = boto3.resource("dynamodb", region_name=region)
        _dynamodb_table = dynamodb.Table(API_KEYS_TABLE_NAME)
        log.info(
            "Initialized DynamoDB table",
            extra={"table": API_KEYS_TABLE_NAME, "region": region},
        )
    return _dynamodb_table


# In-memory cache for validated API keys: {key_hash: {user_sub, user_email, expires_at_cache}}
_api_key_cache = {}
_API_KEY_CACHE_TTL = 300  # 5 minutes


@web.middleware
async def api_key_auth_middleware(request, handler):
    """Validate X-API-Key header for non-JWT requests."""
    path = request.path

    # Skip health checks and management endpoints (JWT-protected separately)
    if path in ("/health", "/ready") or path.startswith("/health/") or path.startswith("/v1/api-keys"):
        return await handler(request)

    # Skip if Authorization header present (JWT path — already validated by ALB)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        # Decode JWT to extract user identity for logging
        claims = decode_jwt_payload(auth_header[7:])
        if claims:
            request["auth_source"] = "jwt"
            request["user_sub"] = claims.get("sub", "")
            request["user_email"] = claims.get("email", "")
        return await handler(request)

    # Check for API key
    api_key = request.headers.get("X-API-Key", "")
    if not api_key or not api_key.startswith(API_KEY_PREFIX):
        return web.json_response(
            {"error": {"message": "Authentication required", "type": "auth_error", "code": "missing_credentials"}},
            status=401,
        )

    key_hash = hash_api_key(api_key)
    now = time.time()

    # Check in-memory cache first
    cached = _api_key_cache.get(key_hash)
    if cached and now < cached["cache_expires"]:
        request["auth_source"] = "api_key"
        request["user_sub"] = cached["user_sub"]
        request["user_email"] = cached["user_email"]
        # Fire-and-forget last_used_at update
        asyncio.get_event_loop().run_in_executor(
            _executor, _update_last_used, key_hash
        )
        return await handler(request)

    # Validate against DynamoDB
    loop = asyncio.get_event_loop()
    try:
        item = await loop.run_in_executor(_executor, _lookup_api_key, key_hash)
    except Exception as e:
        log.error("DynamoDB lookup failed", extra={"error": str(e)})
        return web.json_response(
            {"error": {"message": "Internal authentication error", "type": "auth_error", "code": "internal_error"}},
            status=500,
        )

    if not item:
        return web.json_response(
            {"error": {"message": "Invalid API key", "type": "auth_error", "code": "invalid_api_key"}},
            status=401,
        )

    # Check status
    if item.get("status") != "active":
        return web.json_response(
            {"error": {"message": "API key has been revoked", "type": "auth_error", "code": "revoked_api_key"}},
            status=401,
        )

    # Check expiry
    expires_at = item.get("expires_at", "")
    if expires_at and datetime.fromisoformat(expires_at) < datetime.now(timezone.utc):
        return web.json_response(
            {"error": {"message": "API key has expired", "type": "auth_error", "code": "expired_api_key"}},
            status=401,
        )

    # Cache the validated key
    _api_key_cache[key_hash] = {
        "user_sub": item["user_sub"],
        "user_email": item.get("user_email", ""),
        "cache_expires": now + _API_KEY_CACHE_TTL,
    }

    request["auth_source"] = "api_key"
    request["user_sub"] = item["user_sub"]
    request["user_email"] = item.get("user_email", "")

    # Fire-and-forget last_used_at update
    asyncio.get_event_loop().run_in_executor(_executor, _update_last_used, key_hash)

    return await handler(request)


def _lookup_api_key(key_hash):
    """Synchronous DynamoDB get_item (runs in executor)."""
    table = get_dynamodb_table()
    resp = table.get_item(Key={"key_hash": key_hash})
    return resp.get("Item")


def _update_last_used(key_hash):
    """Synchronous fire-and-forget update of last_used_at."""
    try:
        table = get_dynamodb_table()
        table.update_item(
            Key={"key_hash": key_hash},
            UpdateExpression="SET last_used_at = :now",
            ExpressionAttributeValues={":now": datetime.now(timezone.utc).isoformat()},
        )
    except Exception as e:
        log.warning("Failed to update last_used_at", extra={"error": str(e)})


# ---------------------------------------------------------------------------
# API Key Management Endpoints (JWT-protected)
# ---------------------------------------------------------------------------

def _extract_jwt_identity(request):
    """Extract user identity from JWT Bearer token (ALB already validated)."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None, None
    claims = decode_jwt_payload(auth_header[7:])
    if not claims:
        return None, None
    return claims.get("sub"), claims.get("email", "")


async def create_api_key(request):
    """POST /v1/api-keys — create a new API key."""
    request_id = request.get("request_id", str(uuid.uuid4()))
    user_sub, user_email = _extract_jwt_identity(request)
    if not user_sub:
        return web.json_response(
            {"error": "Authentication required"}, status=401,
            headers={"X-Request-ID": request_id},
        )

    try:
        body = await request.json()
    except (json.JSONDecodeError, Exception):
        body = {}

    description = body.get("description", "")
    expires_in_days = body.get("expires_in_days", DEFAULT_EXPIRY_DAYS)

    # Validate expiry
    try:
        expires_in_days = int(expires_in_days)
    except (ValueError, TypeError):
        expires_in_days = DEFAULT_EXPIRY_DAYS
    if expires_in_days < MIN_EXPIRY_DAYS or expires_in_days > MAX_EXPIRY_DAYS:
        return web.json_response(
            {"error": f"expires_in_days must be between {MIN_EXPIRY_DAYS} and {MAX_EXPIRY_DAYS}"},
            status=400, headers={"X-Request-ID": request_id},
        )

    # Check max keys per user
    loop = asyncio.get_event_loop()
    try:
        existing_keys = await loop.run_in_executor(
            _executor, _list_user_keys, user_sub
        )
    except Exception as e:
        log.error("Failed to list user keys", extra={"error": str(e), "request_id": request_id})
        return web.json_response(
            {"error": "Internal error"}, status=500,
            headers={"X-Request-ID": request_id},
        )

    active_keys = [k for k in existing_keys if k.get("status") == "active"]
    if len(active_keys) >= MAX_KEYS_PER_USER:
        return web.json_response(
            {"error": f"Maximum of {MAX_KEYS_PER_USER} active API keys per user"},
            status=409, headers={"X-Request-ID": request_id},
        )

    # Generate key
    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)
    key_prefix = raw_key[:10]  # "oc_" + first 7 chars of random part
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=expires_in_days)
    # TTL: 30 days after expiry for DynamoDB auto-cleanup
    ttl_value = int(expires_at.timestamp()) + (30 * 86400)

    item = {
        "key_hash": key_hash,
        "key_prefix": key_prefix,
        "user_sub": user_sub,
        "user_email": user_email,
        "description": description,
        "status": "active",
        "created_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
        "ttl": ttl_value,
    }

    try:
        await loop.run_in_executor(_executor, _put_api_key, item)
    except Exception as e:
        log.error("Failed to create API key", extra={"error": str(e), "request_id": request_id})
        return web.json_response(
            {"error": "Failed to create API key"}, status=500,
            headers={"X-Request-ID": request_id},
        )

    log.info(
        "API key created",
        extra={
            "request_id": request_id,
            "user_sub": user_sub,
            "key_prefix": key_prefix,
        },
    )

    return web.json_response(
        {
            "key": raw_key,
            "key_prefix": key_prefix,
            "description": description,
            "status": "active",
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
        },
        status=201,
        headers={"X-Request-ID": request_id},
    )


async def list_api_keys(request):
    """GET /v1/api-keys — list user's API keys (never returns full key)."""
    request_id = request.get("request_id", str(uuid.uuid4()))
    user_sub, _ = _extract_jwt_identity(request)
    if not user_sub:
        return web.json_response(
            {"error": "Authentication required"}, status=401,
            headers={"X-Request-ID": request_id},
        )

    loop = asyncio.get_event_loop()
    try:
        items = await loop.run_in_executor(_executor, _list_user_keys, user_sub)
    except Exception as e:
        log.error("Failed to list API keys", extra={"error": str(e), "request_id": request_id})
        return web.json_response(
            {"error": "Internal error"}, status=500,
            headers={"X-Request-ID": request_id},
        )

    keys = []
    for item in items:
        keys.append({
            "key_prefix": item.get("key_prefix", ""),
            "description": item.get("description", ""),
            "status": item.get("status", ""),
            "created_at": item.get("created_at", ""),
            "expires_at": item.get("expires_at", ""),
            "last_used_at": item.get("last_used_at", None),
        })

    return web.json_response(
        {"keys": keys},
        headers={"X-Request-ID": request_id},
    )


async def revoke_api_key(request):
    """DELETE /v1/api-keys/{key_prefix} — revoke a key."""
    request_id = request.get("request_id", str(uuid.uuid4()))
    user_sub, _ = _extract_jwt_identity(request)
    if not user_sub:
        return web.json_response(
            {"error": "Authentication required"}, status=401,
            headers={"X-Request-ID": request_id},
        )

    key_prefix = request.match_info.get("key_prefix", "")
    if not key_prefix:
        return web.json_response(
            {"error": "key_prefix is required"}, status=400,
            headers={"X-Request-ID": request_id},
        )

    # Find the key by prefix in user's keys
    loop = asyncio.get_event_loop()
    try:
        items = await loop.run_in_executor(_executor, _list_user_keys, user_sub)
    except Exception as e:
        log.error("Failed to list keys for revocation", extra={"error": str(e), "request_id": request_id})
        return web.json_response(
            {"error": "Internal error"}, status=500,
            headers={"X-Request-ID": request_id},
        )

    target = None
    for item in items:
        if item.get("key_prefix") == key_prefix:
            target = item
            break

    if not target:
        return web.json_response(
            {"error": "API key not found"}, status=404,
            headers={"X-Request-ID": request_id},
        )

    if target.get("status") == "revoked":
        return web.json_response(
            {"error": "API key already revoked"}, status=409,
            headers={"X-Request-ID": request_id},
        )

    # Revoke with condition on user_sub to prevent cross-user revocation
    try:
        await loop.run_in_executor(
            _executor, _revoke_api_key, target["key_hash"], user_sub
        )
    except Exception as e:
        log.error("Failed to revoke API key", extra={"error": str(e), "request_id": request_id})
        return web.json_response(
            {"error": "Failed to revoke API key"}, status=500,
            headers={"X-Request-ID": request_id},
        )

    # Invalidate cache
    _api_key_cache.pop(target["key_hash"], None)

    log.info(
        "API key revoked",
        extra={
            "request_id": request_id,
            "user_sub": user_sub,
            "key_prefix": key_prefix,
        },
    )

    return web.json_response(
        {"status": "revoked", "key_prefix": key_prefix},
        headers={"X-Request-ID": request_id},
    )


def _put_api_key(item):
    """Synchronous DynamoDB put_item (runs in executor)."""
    table = get_dynamodb_table()
    table.put_item(Item=item)


def _list_user_keys(user_sub):
    """Synchronous DynamoDB query on user-sub-index (runs in executor)."""
    table = get_dynamodb_table()
    resp = table.query(
        IndexName="user-sub-index",
        KeyConditionExpression="user_sub = :sub",
        ExpressionAttributeValues={":sub": user_sub},
    )
    return resp.get("Items", [])


def _revoke_api_key(key_hash, user_sub):
    """Synchronous DynamoDB update to revoke key (runs in executor)."""
    table = get_dynamodb_table()
    now = datetime.now(timezone.utc).isoformat()
    table.update_item(
        Key={"key_hash": key_hash},
        UpdateExpression="SET #s = :revoked, revoked_at = :now",
        ConditionExpression="user_sub = :sub",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":revoked": "revoked",
            ":now": now,
            ":sub": user_sub,
        },
    )


# Health check endpoints
async def health(request):
    """Basic health check for ALB."""
    return web.json_response(
        {
            "status": "healthy",
            "service": "bedrock-router",
            "version": SERVICE_VERSION,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    )


async def ready(request):
    """Deep health check - validates token can be generated."""
    try:
        # Try to get a token to ensure IAM permissions are working
        token = get_token()
        if token:
            return web.json_response(
                {
                    "status": "ready",
                    "service": "bedrock-router",
                    "version": SERVICE_VERSION,
                    "token_status": "valid",
                    "timestamp": datetime.now(timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                }
            )
    except Exception as e:
        log.error("Readiness check failed", extra={"error": str(e)})
        return web.json_response(
            {"status": "not_ready", "error": "Token generation failed"}, status=503
        )


async def models(request):
    """List available models."""
    data = [
        {"id": k, "object": "model", "owned_by": "bedrock"} for k in get_model_map()
    ]
    return web.json_response({"object": "list", "data": data})


@web.middleware
async def request_logging_middleware(request, handler):
    """Add request ID and log all requests."""
    # Skip logging for health check endpoints to reduce log noise
    path = request.path
    if path in ("/health", "/ready") or path.startswith("/health/"):
        request["request_id"] = request.headers.get("X-Request-ID", str(uuid.uuid4()))
        response = await handler(request)
        response.headers["X-Request-ID"] = request["request_id"]
        return response

    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    request["request_id"] = request_id

    start_time = time.time()

    log.info(
        "Request started",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.path,
            "user_agent": request.headers.get("User-Agent", "unknown"),
        },
    )

    try:
        response = await handler(request)
        duration_ms = int((time.time() - start_time) * 1000)

        log.info(
            "Request completed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.path,
                "status": response.status,
                "duration_ms": duration_ms,
            },
        )

        # Add request ID to response headers
        response.headers["X-Request-ID"] = request_id
        return response

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        log.error(
            "Request failed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.path,
                "error": str(e),
                "duration_ms": duration_ms,
            },
        )
        raise


async def chat_completions(request):
    """Handle chat completion requests — routes to Converse API or Mantle proxy."""
    request_id = request.get("request_id", str(uuid.uuid4()))

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON in request body"}, status=400)

    model_map = get_model_map()
    requested = body.get("model", "")

    # Map model name if needed
    if requested in model_map:
        body["model"] = model_map[requested]
        log.info(
            "Model mapped",
            extra={
                "request_id": request_id,
                "requested_model": requested,
                "mapped_model": body["model"],
            },
        )

    mapped_model = body.get("model", "")

    log.info(
        "Routing decision",
        extra={
            "request_id": request_id,
            "requested_model": requested,
            "mapped_model": mapped_model,
            "route": "converse" if is_anthropic_model(mapped_model) else "mantle",
        },
    )

    # ---- Anthropic models → Bedrock Converse API ----
    if is_anthropic_model(mapped_model):
        is_stream = body.get("stream", False)
        log.info(
            "Routing to Converse API",
            extra={
                "request_id": request_id,
                "model": mapped_model,
                "stream": is_stream,
            },
        )
        if is_stream:
            return await handle_anthropic_streaming(body, request_id, request)
        else:
            return await handle_anthropic_non_streaming(body, request_id)

    # ---- All other models → Mantle proxy (unchanged) ----

    # Get authentication token
    try:
        token = get_token()
    except Exception as e:
        log.error(
            "Failed to get Bedrock token",
            extra={"request_id": request_id, "error": str(e)},
        )
        return web.json_response({"error": "Authentication failed"}, status=500)

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-Request-ID": request_id,
    }
    target = f"{MANTLE_URL}/v1/chat/completions"
    is_stream = body.get("stream", False)

    log.info(
        "Forwarding to Bedrock Mantle",
        extra={
            "request_id": request_id,
            "model": body.get("model"),
            "stream": is_stream,
        },
    )

    timeout = aiohttp.ClientTimeout(total=600)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        try:
            async with session.post(target, json=body, headers=headers) as resp:
                if not is_stream:
                    data = await resp.read()
                    return web.Response(
                        body=data,
                        status=resp.status,
                        content_type=resp.content_type,
                        headers={"X-Request-ID": request_id},
                    )

                # Streaming response
                response = web.StreamResponse(
                    status=resp.status,
                    headers={
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "X-Request-ID": request_id,
                    },
                )
                await response.prepare(request)

                async for chunk in resp.content.iter_any():
                    await response.write(chunk)

                await response.write_eof()
                return response

        except aiohttp.ClientError as e:
            log.error(
                "Bedrock Mantle request failed",
                extra={"request_id": request_id, "error": str(e)},
            )
            return web.json_response(
                {"error": "Upstream service unavailable"}, status=502
            )


# Graceful shutdown handling
async def on_shutdown(app):
    """Handle graceful shutdown."""
    log.info("Shutting down gracefully...")
    _executor.shutdown(wait=False)


def setup_signal_handlers(app):
    """Setup signal handlers for graceful shutdown."""

    def signal_handler(sig):
        log.info(f"Received signal {sig.name}")
        asyncio.create_task(app.shutdown())

    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_event_loop().add_signal_handler(
            sig, lambda s=sig: signal_handler(s)
        )


# Create application
app = web.Application(middlewares=[api_key_auth_middleware, request_logging_middleware])
app.router.add_get("/health", health)
app.router.add_get("/ready", ready)
app.router.add_get("/v1/models", models)
app.router.add_post("/v1/chat/completions", chat_completions)
# API key management endpoints (JWT-protected via ALB rule)
app.router.add_post("/v1/api-keys", create_api_key)
app.router.add_get("/v1/api-keys", list_api_keys)
app.router.add_delete("/v1/api-keys/{key_prefix}", revoke_api_key)
app.on_shutdown.append(on_shutdown)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    log.info(
        "Starting Bedrock router",
        extra={"port": port, "mantle_url": MANTLE_URL, "version": SERVICE_VERSION},
    )

    web.run_app(
        app,
        host="0.0.0.0",
        port=port,
        print=None,
        access_log=None,  # We handle logging via middleware
    )
