#!/usr/bin/env python3
"""Render Kubernetes image placeholders to verified OCI manifest-digest references.

The input must contain image declarations ending in :REPLACE_WITH_IMMUTABLE_TAG.
For every such image this program resolves <repository>:<tag> through the OCI
Distribution API, verifies a registry-returned SHA-256 Docker-Content-Digest,
and writes <repository>@sha256:<digest> to the output. It fails closed for an
unapproved registry, unresolved image, missing registry digest, placeholder in
output, or malformed digest.

The script deliberately does not build, push, sign, or deploy an image. It is
intended to run after the CI image-build and attestation stage has pushed the
exact source revision tag to the registry.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

PLACEHOLDER = "REPLACE_WITH_IMMUTABLE_TAG"
IMAGE_LINE = re.compile(r"^(?P<prefix>\s*image:\s*)(?P<reference>\S+)(?P<suffix>\s*(?:#.*)?$)")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
MANIFEST_ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)


@dataclass(frozen=True)
class ImageReference:
    registry: str
    repository: str

    @property
    def display_name(self) -> str:
        return f"{self.registry}/{self.repository}"


def fail(message: str) -> "None":
    raise ValueError(message)


def parse_placeholder_reference(reference: str, tag: str, allowed_registry: str) -> ImageReference:
    marker = f":{PLACEHOLDER}"
    if not reference.endswith(marker):
        fail(f"image reference must end in {marker}: {reference}")
    name = reference[: -len(marker)]
    parts = name.split("/", maxsplit=1)
    if len(parts) != 2:
        fail(f"image reference must include registry and repository: {reference}")
    registry, repository = parts
    if registry != allowed_registry:
        fail(f"registry {registry!r} is not allowed; expected {allowed_registry!r}")
    if not repository or ".." in repository or repository.startswith("/"):
        fail(f"invalid repository path: {repository!r}")
    if not TAG.fullmatch(tag):
        fail(f"invalid tag {tag!r}")
    return ImageReference(registry=registry, repository=repository)


def basic_authorization(username: str, token: str) -> str:
    raw = f"{username}:{token}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def request(url: str, method: str, headers: Mapping[str, str]) -> urllib.response.addinfourl:
    return urllib.request.urlopen(urllib.request.Request(url, method=method, headers=dict(headers)), timeout=30)


def bearer_challenge(headers: Mapping[str, str]) -> dict[str, str] | None:
    challenge = headers.get("WWW-Authenticate", "")
    if not challenge.lower().startswith("bearer "):
        return None
    attributes = dict(re.findall(r'([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"', challenge))
    if not attributes.get("realm"):
        fail("registry returned an incomplete Bearer authentication challenge")
    return attributes


def obtain_bearer_token(challenge: Mapping[str, str], username: str | None, token: str | None) -> str:
    parameters = {key: value for key, value in challenge.items() if key in {"service", "scope"}}
    url = challenge["realm"]
    separator = "&" if "?" in url else "?"
    if parameters:
        url += separator + urllib.parse.urlencode(parameters)
    headers = {"Accept": "application/json"}
    if username and token:
        headers["Authorization"] = basic_authorization(username, token)
    try:
        with request(url, "GET", headers) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        fail(f"registry token exchange failed with HTTP {error.code}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"registry token exchange returned invalid JSON: {error}")
    bearer = payload.get("token") or payload.get("access_token")
    if not isinstance(bearer, str) or not bearer:
        fail("registry token exchange did not return a bearer token")
    return bearer


def resolve_digest(image: ImageReference, tag: str, username: str | None, token: str | None) -> str:
    url = f"https://{image.registry}/v2/{image.repository}/manifests/{tag}"
    headers = {"Accept": MANIFEST_ACCEPT}
    if username and token:
        headers["Authorization"] = basic_authorization(username, token)
    try:
        response = request(url, "HEAD", headers)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            fail(f"unable to resolve {image.display_name}:{tag}: HTTP {error.code}")
        challenge = bearer_challenge(error.headers)
        if challenge is None:
            fail(f"registry denied {image.display_name}:{tag} without a Bearer challenge")
        bearer = obtain_bearer_token(challenge, username, token)
        headers["Authorization"] = f"Bearer {bearer}"
        try:
            response = request(url, "HEAD", headers)
        except urllib.error.HTTPError as retry_error:
            fail(f"unable to resolve {image.display_name}:{tag} after authentication: HTTP {retry_error.code}")
    with response:
        digest = response.headers.get("Docker-Content-Digest", "")
    if not DIGEST.fullmatch(digest):
        fail(f"registry returned an absent or invalid SHA-256 manifest digest for {image.display_name}:{tag}")
    return digest


def render(input_text: str, tag: str, allowed_registry: str, username: str | None, token: str | None) -> tuple[str, int]:
    cache: dict[str, str] = {}
    replacements = 0
    output_lines: list[str] = []
    for line in input_text.splitlines(keepends=True):
        match = IMAGE_LINE.match(line.rstrip("\n"))
        if not match or PLACEHOLDER not in match.group("reference"):
            output_lines.append(line)
            continue
        reference = match.group("reference")
        image = parse_placeholder_reference(reference, tag, allowed_registry)
        digest = cache.get(image.display_name)
        if digest is None:
            digest = resolve_digest(image, tag, username, token)
            cache[image.display_name] = digest
        newline = "\n" if line.endswith("\n") else ""
        output_lines.append(f"{match.group('prefix')}{image.display_name}@{digest}{match.group('suffix')}{newline}")
        replacements += 1
    rendered = "".join(output_lines)
    if replacements == 0:
        fail("no immutable-tag image placeholders were found in the input")
    if PLACEHOLDER in rendered:
        fail("rendered manifest still contains an immutable-tag placeholder")
    return rendered, replacements


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Rendered multi-document Kubernetes YAML")
    parser.add_argument("--output", type=Path, required=True, help="Destination for the digest-pinned YAML")
    parser.add_argument("--tag", required=True, help="Exact already-pushed source-revision tag to resolve")
    parser.add_argument("--registry", default="ghcr.io", help="Single approved OCI registry hostname")
    parser.add_argument("--username-env", default="GITHUB_ACTOR", help="Environment variable holding registry username")
    parser.add_argument("--token-env", default="GITHUB_TOKEN", help="Environment variable holding registry token")
    args = parser.parse_args()

    username = os.environ.get(args.username_env)
    token = os.environ.get(args.token_env)
    if bool(username) != bool(token):
        print("FAIL: registry username and token must be supplied together or both omitted", file=sys.stderr)
        return 2
    try:
        rendered, replacements = render(args.input.read_text(encoding="utf-8"), args.tag, args.registry, username, token)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    except (OSError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1

    print(f"digest_render=PASS replacements={replacements} registry={args.registry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
