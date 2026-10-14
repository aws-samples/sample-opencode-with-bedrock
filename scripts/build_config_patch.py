#!/usr/bin/env python3
"""Build config-patch.json from the distributed opencode.json.

Existing installs apply this patch on each `oc` launch (see
auth/opencode-auth/configpatch). Every provider field that installs need
must be emitted here, because the installer-time opencode.json is never
re-copied on its own.

Usage (from publish-distribution.sh):
  build_config_patch.py --opencode-json PATH --config-version N \
      [--share-domain D] [--cli-client-id ID] [--api-domain D] \
      [--oidc-issuer URL] [--web-domain D]
"""

import argparse
import json
import sys


def _set(value):
    """CloudFormation lookups yield '' or 'None' when an output is absent."""
    return bool(value) and value != "None"


def build_config_patch(
    oc,
    config_version,
    share_domain=None,
    cli_client_id=None,
    api_domain=None,
    oidc_issuer=None,
    web_domain=None,
):
    set_deep = {}
    for provider_name, provider_config in oc.get("provider", {}).items():
        # OpenCode v2 dropped v1's implicit @ai-sdk/openai-compatible fallback for
        # custom providers; without an explicit package it cannot send requests.
        npm = provider_config.get("npm")
        if npm:
            set_deep[f"provider.{provider_name}.npm"] = npm
        for model_name, model_def in provider_config.get("models", {}).items():
            set_deep[f"provider.{provider_name}.models.{model_name}"] = model_def
        # Also set provider options (e.g. baseURL)
        options = provider_config.get("options")
        if options:
            set_deep[f"provider.{provider_name}.options"] = options

    # If share feature is deployed, add enterprise URL and share mode.
    # The enterprise.url points at the local proxy (localhost:18080) which
    # injects JWT auth headers before forwarding to the share backend.
    if _set(share_domain):
        set_deep["enterprise"] = {"url": "http://localhost:18080"}
        set_deep["share"] = "manual"

    config_set = {}
    if _set(cli_client_id):
        config_set["client_id"] = cli_client_id
    if _set(api_domain):
        config_set["api_endpoint"] = f"https://{api_domain}/v1"
    if _set(oidc_issuer):
        config_set["issuer"] = oidc_issuer
    if _set(web_domain):
        config_set["version_check_url"] = f"https://{web_domain}/version.json"
    if _set(share_domain):
        config_set["share_endpoint"] = share_domain

    return {
        "config_version": int(config_version),
        "patches": {
            "config.json": {"set": config_set},
            "opencode.json": {"set_deep": set_deep},
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--opencode-json", required=True)
    parser.add_argument("--config-version", required=True, type=int)
    parser.add_argument("--share-domain")
    parser.add_argument("--cli-client-id")
    parser.add_argument("--api-domain")
    parser.add_argument("--oidc-issuer")
    parser.add_argument("--web-domain")
    args = parser.parse_args(argv)

    with open(args.opencode_json) as f:
        oc = json.load(f)

    patch = build_config_patch(
        oc,
        args.config_version,
        share_domain=args.share_domain,
        cli_client_id=args.cli_client_id,
        api_domain=args.api_domain,
        oidc_issuer=args.oidc_issuer,
        web_domain=args.web_domain,
    )
    json.dump(patch, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
