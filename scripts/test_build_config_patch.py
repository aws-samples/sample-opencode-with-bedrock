"""Tests for build_config_patch.py.

Run with: python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import json
import os
import unittest

from build_config_patch import build_config_patch

ASSETS_OPENCODE_JSON = os.path.join(
    os.path.dirname(__file__), "..", "services", "distribution", "assets", "opencode.json"
)


def _oc(provider_extra=None):
    provider = {
        "name": "Bedrock Models",
        "options": {"baseURL": "http://localhost:18080/v1"},
        "models": {"claude-sonnet": {"name": "Claude Sonnet 4.6"}},
    }
    provider.update(provider_extra or {})
    return {"provider": {"bedrock": provider}}


class TestExistingBehavior(unittest.TestCase):
    def test_models_and_options_become_set_deep_entries(self):
        patch = build_config_patch(_oc(), config_version=7)
        set_deep = patch["patches"]["opencode.json"]["set_deep"]
        self.assertEqual(patch["config_version"], 7)
        self.assertEqual(set_deep["provider.bedrock.models.claude-sonnet"], {"name": "Claude Sonnet 4.6"})
        self.assertEqual(set_deep["provider.bedrock.options"], {"baseURL": "http://localhost:18080/v1"})

    def test_share_domain_adds_enterprise_and_share(self):
        patch = build_config_patch(_oc(), config_version=1, share_domain="https://share.example.com")
        set_deep = patch["patches"]["opencode.json"]["set_deep"]
        self.assertEqual(set_deep["enterprise"], {"url": "http://localhost:18080"})
        self.assertEqual(set_deep["share"], "manual")
        self.assertEqual(patch["patches"]["config.json"]["set"]["share_endpoint"], "https://share.example.com")

    def test_none_share_domain_is_ignored(self):
        patch = build_config_patch(_oc(), config_version=1, share_domain="None")
        set_deep = patch["patches"]["opencode.json"]["set_deep"]
        self.assertNotIn("enterprise", set_deep)
        self.assertNotIn("share", set_deep)

    def test_config_json_connection_params(self):
        patch = build_config_patch(
            _oc(),
            config_version=1,
            cli_client_id="abc",
            api_domain="oc.example.com",
            oidc_issuer="https://issuer.example.com",
            web_domain="downloads.example.com",
        )
        self.assertEqual(
            patch["patches"]["config.json"]["set"],
            {
                "client_id": "abc",
                "api_endpoint": "https://oc.example.com/v1",
                "issuer": "https://issuer.example.com",
                "version_check_url": "https://downloads.example.com/version.json",
            },
        )

    def test_none_connection_params_are_ignored(self):
        patch = build_config_patch(
            _oc(), config_version=1, cli_client_id="None", api_domain="", oidc_issuer=None, web_domain="None"
        )
        self.assertEqual(patch["patches"]["config.json"]["set"], {})


class TestProviderPackage(unittest.TestCase):
    """OpenCode v2 has no implicit openai-compatible fallback for custom providers,
    so existing installs must receive the provider's npm package via the patch."""

    def test_provider_npm_is_propagated(self):
        patch = build_config_patch(_oc({"npm": "@ai-sdk/openai-compatible"}), config_version=1)
        set_deep = patch["patches"]["opencode.json"]["set_deep"]
        self.assertEqual(set_deep["provider.bedrock.npm"], "@ai-sdk/openai-compatible")

    def test_provider_without_npm_adds_no_npm_entry(self):
        patch = build_config_patch(_oc(), config_version=1)
        self.assertNotIn("provider.bedrock.npm", patch["patches"]["opencode.json"]["set_deep"])

    def test_distributed_config_declares_openai_compatible_package(self):
        with open(ASSETS_OPENCODE_JSON) as f:
            oc = json.load(f)
        self.assertEqual(oc["provider"]["bedrock"].get("npm"), "@ai-sdk/openai-compatible")
        patch = build_config_patch(oc, config_version=1)
        self.assertEqual(
            patch["patches"]["opencode.json"]["set_deep"]["provider.bedrock.npm"], "@ai-sdk/openai-compatible"
        )


if __name__ == "__main__":
    unittest.main()
