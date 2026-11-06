"""Publish a signed bundle to Internal testing using a short-lived CI token."""
import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package")
    parser.add_argument("bundle", type=Path)
    parser.add_argument("version_code", type=int)
    parser.add_argument("release_name")
    args = parser.parse_args()
    token = os.environ["PLAY_ACCESS_TOKEN"]
    base = f"https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{args.package}/edits"

    def request(method, url, body=None, content_type="application/json"):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {token}", "Content-Type": content_type,
        })
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Google Play HTTP {error.code}: {error.read().decode()}") from None

    edit_id = request("POST", base, {})["id"]
    committed = False
    try:
        upload_url = base.replace("/androidpublisher/v3/", "/upload/androidpublisher/v3/")
        bundle = request("POST", f"{upload_url}/{edit_id}/bundles?uploadType=media",
                         args.bundle.read_bytes(), "application/octet-stream")
        code = int(bundle["versionCode"])
        if code != args.version_code:
            raise RuntimeError(f"Bundle version {code} differs from expected {args.version_code}")
        request("PUT", f"{base}/{edit_id}/tracks/internal", {
            "track": "internal", "releases": [{
                "name": args.release_name, "versionCodes": [str(code)], "status": "completed",
            }],
        })
        request("POST", f"{base}/{edit_id}:commit", {})
        committed = True
        print(f"Published {args.package} version {code} to Internal testing.")
    finally:
        if not committed:
            try:
                request("DELETE", f"{base}/{edit_id}")
            except RuntimeError:
                pass


if __name__ == "__main__":
    main()
