import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


def release_context(updates=None, tag=""):
    if POWERSHELL is None:
        pytest.skip("PowerShell is not available")
    env = os.environ.copy()
    env.update({
        "GITHUB_ACTIONS": "true",
        "RUNNER_ENVIRONMENT": "github-hosted",
        "GITHUB_WORKFLOW": "Windows Release",
        "GITHUB_REPOSITORY": "tori128/sheetMusicHelper",
        "GITHUB_SHA": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "GITHUB_RUN_ID": "12345",
        "GITHUB_RUN_ATTEMPT": "1",
        "GITHUB_WORKSPACE": str(ROOT),
        "EARCOPY_TEST_TAG": tag,
    })
    env.update(updates or {})
    return subprocess.run([
        POWERSHELL, "-NoProfile", "-Command",
        "$ErrorActionPreference='Stop'; . ./scripts/ci-release-context.ps1; Get-CiReleaseContext -RequestedTag $env:EARCOPY_TEST_TAG | ConvertTo-Json",
    ], cwd=ROOT, env=env, capture_output=True, text=True)


def test_ci_context_identifies_the_checkout_and_workflow():
    result = release_context()
    assert result.returncode == 0, result.stderr
    context = json.loads(result.stdout)
    assert context["RunId"] == "12345"
    assert context["RunUrl"].endswith("/actions/runs/12345")
    package = json.loads((ROOT / "app/package.json").read_text())
    assert context["Tag"] == "v" + package["version"]


@pytest.mark.parametrize("updates", [
    {"GITHUB_ACTIONS": ""},
    {"RUNNER_ENVIRONMENT": "self-hosted"},
    {"GITHUB_WORKFLOW": "different workflow"},
    {"GITHUB_SHA": "0" * 40},
    {"GITHUB_REPOSITORY": "different/repository"},
    {"GITHUB_RUN_ID": ""},
    {"GITHUB_RUN_ATTEMPT": "invalid"},
    {"GITHUB_WORKSPACE": str(ROOT.parent)},
])
def test_ci_context_rejects_unverified_build_origins(updates):
    assert release_context(updates).returncode != 0


def test_ci_context_rejects_a_tag_that_differs_from_the_package_version():
    assert release_context(tag="v999.0.0").returncode != 0


@pytest.mark.parametrize("pages,exit_code,expected", [
    ([[{"tag_name": "other", "id": 1}], [{"tag_name": "v0.1.7", "draft": True, "id": 42}]], 0, 42),
    ([[]], 0, None),
    ([[]], 1, "failure"),
    ([[{"tag_name": "v0.1.7"}, {"tag_name": "v0.1.7"}]], 0, "failure"),
])
def test_draft_lookup_uses_paginated_release_list(pages, exit_code, expected):
    if POWERSHELL is None:
        pytest.skip("PowerShell is not available")
    env = os.environ.copy()
    env.update({"EARCOPY_TEST_RELEASE_PAGES": json.dumps(pages), "EARCOPY_TEST_EXIT": str(exit_code), "GITHUB_REPOSITORY": "tori128/sheetMusicHelper"})
    command = r'''
$ErrorActionPreference = 'Stop'
. ./scripts/ci-release-context.ps1
function gh {
    if ($args -notcontains '--paginate' -or $args -notcontains '--slurp' -or $args[1] -notlike '*/releases?per_page=100') { throw 'Invalid release query' }
    $global:LASTEXITCODE = [int]$env:EARCOPY_TEST_EXIT
    $env:EARCOPY_TEST_RELEASE_PAGES
}
$release = Get-CiReleaseDraft -Tag 'v0.1.7'
if ($null -eq $release) { 'null' } else { $release.id | ConvertTo-Json }
'''
    result = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], cwd=ROOT, env=env, capture_output=True, text=True)
    if expected == "failure":
        assert result.returncode != 0
    else:
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == expected
